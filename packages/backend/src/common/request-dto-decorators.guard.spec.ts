import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * Guard test for the bug class behind the `POST /api/v1/auth/refresh`
 * incident: `RefreshTokenDto.refreshToken` had only an `@ApiProperty()`
 * (Swagger) decorator and NO `class-validator` decorator. The app's global
 * `ValidationPipe` (`whitelist: true, forbidNonWhitelisted: true` - see
 * `main.ts`) treats any class property with zero class-validator metadata
 * as an unknown property and rejects the whole request with a 400, even
 * though the property is a perfectly valid, intentional field on the DTO.
 *
 * This is a STATIC check (TypeScript AST), not a runtime `class-validator`
 * reflection check, deliberately: an undecorated property leaves *no*
 * runtime trace at all (no decorator ever ran, so there's no metadata to
 * inspect), which is exactly what makes this bug class easy to miss - a
 * runtime-only scanner can't see the properties that are the problem.
 * Parsing the source is the only way to see "this class declares a
 * property that no decorator ever touched".
 *
 * IMPORTANT - scope: this only asserts REQUEST DTOs (bodies/queries that
 * pass through the global ValidationPipe) are decorated. Response DTOs are
 * never validated and are correctly excluded. When adding a new
 * `@Body()`/`@Query()` DTO class anywhere in the app, add it to
 * `REQUEST_DTO_TARGETS` below so this guard covers it too.
 */

// Every class-validator decorator in use anywhere in this codebase's DTOs,
// plus a couple of common ones not yet used but that would also satisfy
// "this property is actually validated". Deliberately does NOT include
// `@ApiProperty`/`@ApiPropertyOptional` (Swagger-only) or bare `@Type`
// (class-transformer-only, coercion without validation) - those decorators
// alone are exactly the failure mode this guard exists to catch.
const CLASS_VALIDATOR_DECORATORS = new Set([
  'IsString',
  'IsNotEmpty',
  'IsOptional',
  'IsNumber',
  'IsInt',
  'IsBoolean',
  'IsEmail',
  'IsUUID',
  'IsArray',
  'IsEnum',
  'ValidateNested',
  'IsUrl',
  'Matches',
  'MinLength',
  'MaxLength',
  'Min',
  'Max',
  'ArrayMaxSize',
  'ArrayMinSize',
  'ArrayNotEmpty',
  'IsObject',
  'IsIn',
  'IsNotIn',
  'IsDate',
  'IsDateString',
  'IsPositive',
  'IsNegative',
  'IsAlpha',
  'IsAlphanumeric',
  'IsJSON',
  'IsJWT',
  'ValidateIf',
  'IsDefined',
  'IsNotEmptyObject',
  'IsBooleanString',
  'IsNumberString',
  'Length',
  'Contains',
  'IsPhoneNumber',
  'IsLatLong',
  'IsHexColor',
]);

interface RequestDtoTarget {
  /** Path relative to `src/`. */
  file: string;
  className: string;
}

// Discovered by the 2026-08 ValidationPipe audit triggered by the
// `/auth/refresh` incident. Files under `github/**` and `marketplace/**`
// were manually audited as part of the same sweep (found clean) but are
// intentionally NOT listed here to avoid this guard depending on modules
// under separate, concurrent active development.
const REQUEST_DTO_TARGETS: RequestDtoTarget[] = [
  { file: 'auth/dto/register.dto.ts', className: 'RegisterDto' },
  { file: 'auth/dto/login.dto.ts', className: 'LoginDto' },
  { file: 'auth/dto/token-response.dto.ts', className: 'RefreshTokenDto' },
  { file: 'auth/dto/forgot-password.dto.ts', className: 'ForgotPasswordDto' },
  { file: 'auth/dto/reset-password.dto.ts', className: 'ResetPasswordDto' },
  { file: 'chat/dto/send-message.dto.ts', className: 'SendMessageDto' },
  { file: 'chat/dto/stream-ticket.dto.ts', className: 'CreateStreamTicketDto' },
  { file: 'chat/conversation.controller.ts', className: 'CreateConversationDto' },
  { file: 'chat/conversation.controller.ts', className: 'UpdateConversationDto' },
  { file: 'api-key/dto/create-api-key.dto.ts', className: 'CreateApiKeyDto' },
  { file: 'deployment/dto/deploy-request.dto.ts', className: 'DeploymentOptionsDto' },
  { file: 'deployment/dto/deploy-request.dto.ts', className: 'DeployToGitHubDto' },
  { file: 'deployment/dto/deploy-request.dto.ts', className: 'DeployToGistDto' },
  { file: 'deployment/dto/deploy-request.dto.ts', className: 'RetryDeploymentDto' },
  { file: 'deployment/dto/deploy-request.dto.ts', className: 'UpdateGistDto' },
  { file: 'deployment/dto/deploy-request.dto.ts', className: 'ListDeploymentsQueryDto' },
  { file: 'deployment/dto/deploy-request.dto.ts', className: 'EnterpriseOptionsDto' },
  { file: 'deployment/dto/deploy-request.dto.ts', className: 'DeployToEnterpriseDto' },
  { file: 'hosting/dto/deploy-server.dto.ts', className: 'DeployServerDto' },
  { file: 'subscription/dto/subscription.dto.ts', className: 'CreateCheckoutDto' },
  { file: 'user/dto/user.dto.ts', className: 'UpdateAccountDto' },
  { file: 'logging/error-log.controller.ts', className: 'ResolveErrorDto' },
  { file: 'logging/error-log.controller.ts', className: 'ResolveMultipleErrorsDto' },
  { file: 'validation/validation.controller.ts', className: 'ValidateDeploymentDto' },
];

function getDecoratorName(decorator: ts.Decorator): string | undefined {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text;
  }
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  return undefined;
}

/** Returns the list of property names on `className` that have ZERO decorators at all. */
function findUndecoratedProperties(sourceText: string, fileName: string, className: string): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const undecorated: string[] = [];
  let found = false;

  function visitClass(node: ts.ClassDeclaration) {
    found = true;
    for (const member of node.members) {
      if (!ts.isPropertyDeclaration(member)) continue;
      if (!ts.isIdentifier(member.name)) continue;

      const decorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
      if (!decorators || decorators.length === 0) {
        undecorated.push(member.name.text);
      }
    }
  }

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      visitClass(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (!found) {
    throw new Error(`Class "${className}" not found in ${fileName} - update REQUEST_DTO_TARGETS`);
  }

  return undecorated;
}

/** Returns property names that have at least one decorator, but none of them are class-validator decorators. */
function findPropertiesMissingClassValidatorDecorator(
  sourceText: string,
  fileName: string,
  className: string,
): string[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const offenders: string[] = [];

  function visit(node: ts.Node) {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (!ts.isPropertyDeclaration(member)) continue;
        if (!ts.isIdentifier(member.name)) continue;

        const decorators = ts.canHaveDecorators(member) ? ts.getDecorators(member) : undefined;
        const decoratorNames = (decorators ?? [])
          .map(getDecoratorName)
          .filter((n): n is string => !!n);

        const hasValidator = decoratorNames.some((n) => CLASS_VALIDATOR_DECORATORS.has(n));
        if (!hasValidator) {
          offenders.push(`${member.name.text} (decorators found: [${decoratorNames.join(', ') || 'none'}])`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return offenders;
}

describe('Request DTO validation decorator guard', () => {
  const srcRoot = path.resolve(__dirname, '..');

  for (const target of REQUEST_DTO_TARGETS) {
    const fullPath = path.join(srcRoot, target.file);

    describe(`${target.file} :: ${target.className}`, () => {
      let sourceText: string;

      beforeAll(() => {
        sourceText = fs.readFileSync(fullPath, 'utf8');
      });

      it('exists and has no properties with zero decorators', () => {
        const undecorated = findUndecoratedProperties(sourceText, fullPath, target.className);
        expect(undecorated).toEqual([]);
      });

      it('has no properties decorated only with non-validator decorators (e.g. @ApiProperty only)', () => {
        const offenders = findPropertiesMissingClassValidatorDecorator(sourceText, fullPath, target.className);
        expect(offenders).toEqual([]);
      });
    });
  }

  it('the target list itself is non-empty (sanity check against an accidentally-emptied file)', () => {
    expect(REQUEST_DTO_TARGETS.length).toBeGreaterThan(15);
  });
});
