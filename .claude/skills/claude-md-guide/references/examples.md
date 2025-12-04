# CLAUDE.md Examples and Patterns

## Minimal Effective Example

```markdown
# Bash commands

- npm run build: Build the project
- npm run typecheck: Run the typechecker

# Code style

- Use ES modules (import/export) syntax, not CommonJS (require)
- Destructure imports when possible (eg. import { foo } from 'bar')

# Workflow

- Be sure to typecheck when you're done making a series of code changes
- Prefer running single tests, not the whole test suite, for performance
```

## Full-Featured Example

```markdown
# Project Context

A Next.js e-commerce platform with Stripe integration and PostgreSQL backend.

## Tech Stack

- Next.js 14, React 18, TypeScript 5.3
- Tailwind CSS 3.4, shadcn/ui components
- Prisma ORM, PostgreSQL 16
- Stripe for payments, Resend for email

## Commands

- `pnpm dev` - development server on localhost:3000
- `pnpm test` - run Vitest test suite
- `pnpm test:e2e` - run Playwright e2e tests
- `pnpm lint` - ESLint check
- `pnpm db:push` - push Prisma schema changes
- `pnpm db:studio` - open Prisma Studio

## Standards

- All functions require TypeScript types
- Components use named exports, not default
- API routes return typed responses using `NextResponse.json<T>()`
- Database queries use Prisma transactions for multi-table operations

## Testing

- Unit tests in `__tests__/` folders adjacent to source
- E2E tests in `e2e/` folder at root
- Run single test: `pnpm test path/to/file.test.ts`

## Workflow

- Check ./docs/architecture.md for system design decisions
- Check ./docs/api.md before modifying API routes
- Run `pnpm lint && pnpm typecheck` before committing
- All PRs require passing CI checks

## IMPORTANT

- NEVER commit .env files or expose API keys
- Always use `getServerSession()` for auth checks in API routes
- Run database migrations in a transaction
```

## Monorepo Pattern

For monorepos, use component-specific CLAUDE.md files:

```
project-root/
  ├── CLAUDE.md # Shared conventions
  ├── packages/
  │ ├── api/
  │ │ └── CLAUDE.md # API-specific commands and patterns
  │ ├── web/
  │ │ └── CLAUDE.md # Frontend conventions
  │ └── shared/
  │   └── CLAUDE.md # Shared library guidelines
```

Root CLAUDE.md:

```markdown
# Monorepo Commands
- `pnpm install` - install all dependencies
- `pnpm build` - build all packages
- `pnpm -F <package> <command>` - run command in specific package

## Workflow

- Changes to `packages/shared` require rebuilding dependent packages
- Use `pnpm changeset` for version management
```

Package-specific CLAUDE.md (packages/api/):

```markdown
# API Package

## Commands

- `pnpm dev` - start API server
- `pnpm test` - run API tests
- `pnpm generate` - regenerate Prisma client

## Standards

- All endpoints require Zod validation schemas
- Use `createTRPCRouter` for new routes
- Error responses use RFC 7807 format
```

## Import Syntax

Reference external files without embedding their full content:

```markdown
## Documentation References
- For database schema details, read @prisma/schema.prisma
- For API contracts, read @docs/openapi.yaml
- For deployment procedures, read @docs/deployment.md when deploying
```

This tells Claude when to read files rather than loading them every session.

## Constraint Pairs (Do/Don't)

Always pair prohibitions with preferred alternatives:

```markdown
## Standards
- Never use `any` type; prefer `unknown` with type guards
- Never use `console.log` in production; prefer structured logger
- Never mutate state directly; prefer immutable patterns or Immer
- Never use `innerHTML`; prefer React's JSX or `textContent`
```

## Critical Instructions Pattern

Use emphasis markers for must-follow rules:

```markdown
## IMPORTANT

These rules must ALWAYS be followed:
- YOU MUST run `pnpm typecheck` before any commit
- NEVER modify files in `generated/` - they are auto-generated
- ALWAYS use the team's PR template at .github/PULL_REQUEST_TEMPLATE.md
```

## Token-Conscious Large Team Pattern

For teams with many tools, document only high-usage items:

```markdown
# Build Tools (daily use)
- `make dev` - development environment
- `make test` - full test suite
- `make deploy-staging` - deploy to staging

# Debugging (as needed)

See @docs/debugging.md for advanced debugging procedures.

# Infrastructure (rare)

See @docs/infrastructure.md when modifying cloud resources.
```

## Testing Instruction Adherence

Add a verification phrase to test if CLAUDE.md is being followed:

```markdown
## Meta

When greeting the user, always say "Greetings, captain!" first.

If Claude stops using the nickname, your CLAUDE.md has become too long or noisy.
```
