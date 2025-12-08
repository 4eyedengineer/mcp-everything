/**
 * MCP Schema Validator
 *
 * Validates MCP tool input schemas against JSON Schema specification.
 * Ensures tool schemas are valid and properly structured for MCP protocol.
 */

/**
 * Schema validation result
 */
export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  schema?: any;
}

/**
 * Valid JSON Schema types
 */
const VALID_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'];

/**
 * Valid JSON Schema string formats
 */
const VALID_FORMATS = [
  'date-time', 'date', 'time', 'duration',
  'email', 'idn-email',
  'hostname', 'idn-hostname',
  'ipv4', 'ipv6',
  'uri', 'uri-reference', 'iri', 'iri-reference',
  'uuid', 'json-pointer', 'relative-json-pointer',
  'regex',
];

/**
 * MCP Schema Validator
 *
 * Validates tool input schemas according to JSON Schema Draft-07 specification
 * with MCP-specific requirements.
 */
export class McpSchemaValidator {
  /**
   * Validate a tool's input schema
   *
   * @param toolName - Name of the tool (for error messages)
   * @param schema - The input schema to validate
   * @returns Validation result
   */
  validateToolSchema(toolName: string, schema: any): SchemaValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Schema must exist
    if (!schema) {
      errors.push(`Tool "${toolName}" has no input schema`);
      return { valid: false, errors, warnings };
    }

    // Schema must be an object
    if (typeof schema !== 'object' || Array.isArray(schema)) {
      errors.push(`Tool "${toolName}" schema must be an object`);
      return { valid: false, errors, warnings };
    }

    // Root schema should have type: "object" for MCP tools
    if (schema.type && schema.type !== 'object') {
      warnings.push(`Tool "${toolName}" root schema should have type "object", got "${schema.type}"`);
    }

    // If type is object, validate properties
    if (schema.type === 'object' || !schema.type) {
      // Properties should be an object if present
      if (schema.properties !== undefined) {
        if (typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
          errors.push(`Tool "${toolName}" properties must be an object`);
        } else {
          // Validate each property
          for (const [propName, propSchema] of Object.entries(schema.properties)) {
            const propErrors = this.validatePropertySchema(toolName, propName, propSchema);
            errors.push(...propErrors);
          }
        }
      }

      // Required should be an array of strings
      if (schema.required !== undefined) {
        if (!Array.isArray(schema.required)) {
          errors.push(`Tool "${toolName}" required must be an array`);
        } else {
          // Check all required properties exist in properties
          if (schema.properties) {
            for (const reqProp of schema.required) {
              if (typeof reqProp !== 'string') {
                errors.push(`Tool "${toolName}" required contains non-string value`);
              } else if (!(reqProp in schema.properties)) {
                warnings.push(`Tool "${toolName}" required property "${reqProp}" not in properties`);
              }
            }
          }
        }
      }

      // additionalProperties should be boolean or object
      if (schema.additionalProperties !== undefined) {
        if (
          typeof schema.additionalProperties !== 'boolean' &&
          typeof schema.additionalProperties !== 'object'
        ) {
          errors.push(`Tool "${toolName}" additionalProperties must be boolean or object`);
        }
      }
    }

    // Validate schema keywords
    const schemaErrors = this.validateSchemaKeywords(toolName, schema);
    errors.push(...schemaErrors);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      schema,
    };
  }

  /**
   * Validate a property schema
   */
  private validatePropertySchema(
    toolName: string,
    propName: string,
    schema: any
  ): string[] {
    const errors: string[] = [];

    if (!schema || typeof schema !== 'object') {
      errors.push(`Tool "${toolName}" property "${propName}" must be an object`);
      return errors;
    }

    // Type validation
    if (schema.type !== undefined) {
      if (Array.isArray(schema.type)) {
        // Union types
        for (const t of schema.type) {
          if (!VALID_TYPES.includes(t)) {
            errors.push(`Tool "${toolName}" property "${propName}" has invalid type "${t}"`);
          }
        }
      } else if (!VALID_TYPES.includes(schema.type)) {
        errors.push(`Tool "${toolName}" property "${propName}" has invalid type "${schema.type}"`);
      }
    }

    // String-specific validations
    if (schema.type === 'string') {
      if (schema.minLength !== undefined && typeof schema.minLength !== 'number') {
        errors.push(`Tool "${toolName}" property "${propName}" minLength must be a number`);
      }
      if (schema.maxLength !== undefined && typeof schema.maxLength !== 'number') {
        errors.push(`Tool "${toolName}" property "${propName}" maxLength must be a number`);
      }
      if (schema.pattern !== undefined && typeof schema.pattern !== 'string') {
        errors.push(`Tool "${toolName}" property "${propName}" pattern must be a string`);
      }
      if (schema.format !== undefined && !VALID_FORMATS.includes(schema.format)) {
        // Don't error on custom formats, just validate it's a string
        if (typeof schema.format !== 'string') {
          errors.push(`Tool "${toolName}" property "${propName}" format must be a string`);
        }
      }
    }

    // Number-specific validations
    if (schema.type === 'number' || schema.type === 'integer') {
      if (schema.minimum !== undefined && typeof schema.minimum !== 'number') {
        errors.push(`Tool "${toolName}" property "${propName}" minimum must be a number`);
      }
      if (schema.maximum !== undefined && typeof schema.maximum !== 'number') {
        errors.push(`Tool "${toolName}" property "${propName}" maximum must be a number`);
      }
      if (schema.exclusiveMinimum !== undefined && typeof schema.exclusiveMinimum !== 'number') {
        errors.push(`Tool "${toolName}" property "${propName}" exclusiveMinimum must be a number`);
      }
      if (schema.exclusiveMaximum !== undefined && typeof schema.exclusiveMaximum !== 'number') {
        errors.push(`Tool "${toolName}" property "${propName}" exclusiveMaximum must be a number`);
      }
      if (schema.multipleOf !== undefined && typeof schema.multipleOf !== 'number') {
        errors.push(`Tool "${toolName}" property "${propName}" multipleOf must be a number`);
      }
    }

    // Array-specific validations
    if (schema.type === 'array') {
      if (schema.items !== undefined && typeof schema.items !== 'object') {
        errors.push(`Tool "${toolName}" property "${propName}" items must be an object`);
      }
      if (schema.minItems !== undefined && typeof schema.minItems !== 'number') {
        errors.push(`Tool "${toolName}" property "${propName}" minItems must be a number`);
      }
      if (schema.maxItems !== undefined && typeof schema.maxItems !== 'number') {
        errors.push(`Tool "${toolName}" property "${propName}" maxItems must be a number`);
      }
      if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== 'boolean') {
        errors.push(`Tool "${toolName}" property "${propName}" uniqueItems must be a boolean`);
      }
    }

    // Object-specific validations (nested)
    if (schema.type === 'object') {
      if (schema.properties !== undefined && typeof schema.properties !== 'object') {
        errors.push(`Tool "${toolName}" property "${propName}" properties must be an object`);
      }
    }

    // Enum validation
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum)) {
        errors.push(`Tool "${toolName}" property "${propName}" enum must be an array`);
      } else if (schema.enum.length === 0) {
        errors.push(`Tool "${toolName}" property "${propName}" enum must not be empty`);
      }
    }

    // Const validation
    if (schema.const !== undefined && schema.enum !== undefined) {
      errors.push(`Tool "${toolName}" property "${propName}" cannot have both const and enum`);
    }

    return errors;
  }

  /**
   * Validate schema-level keywords
   */
  private validateSchemaKeywords(toolName: string, schema: any): string[] {
    const errors: string[] = [];

    // $schema validation
    if (schema.$schema !== undefined && typeof schema.$schema !== 'string') {
      errors.push(`Tool "${toolName}" $schema must be a string`);
    }

    // title and description
    if (schema.title !== undefined && typeof schema.title !== 'string') {
      errors.push(`Tool "${toolName}" title must be a string`);
    }
    if (schema.description !== undefined && typeof schema.description !== 'string') {
      errors.push(`Tool "${toolName}" description must be a string`);
    }

    // default validation - just check it exists if present
    // (actual type validation would require knowing the schema type)

    // allOf, anyOf, oneOf validation
    for (const combiner of ['allOf', 'anyOf', 'oneOf']) {
      if (schema[combiner] !== undefined) {
        if (!Array.isArray(schema[combiner])) {
          errors.push(`Tool "${toolName}" ${combiner} must be an array`);
        } else if (schema[combiner].length === 0) {
          errors.push(`Tool "${toolName}" ${combiner} must not be empty`);
        }
      }
    }

    // not validation
    if (schema.not !== undefined && typeof schema.not !== 'object') {
      errors.push(`Tool "${toolName}" not must be an object`);
    }

    // if/then/else validation
    if (schema.if !== undefined && typeof schema.if !== 'object') {
      errors.push(`Tool "${toolName}" if must be an object`);
    }
    if (schema.then !== undefined && typeof schema.then !== 'object') {
      errors.push(`Tool "${toolName}" then must be an object`);
    }
    if (schema.else !== undefined && typeof schema.else !== 'object') {
      errors.push(`Tool "${toolName}" else must be an object`);
    }

    return errors;
  }

  /**
   * Validate that a schema is well-formed for MCP usage
   *
   * @param schema - Schema to validate
   * @returns True if schema is valid for MCP
   */
  isValidMcpSchema(schema: any): boolean {
    const result = this.validateToolSchema('anonymous', schema);
    return result.valid;
  }

  /**
   * Extract parameter info from schema for documentation
   *
   * @param schema - Tool input schema
   * @returns Array of parameter info objects
   */
  extractParameterInfo(schema: any): Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
    default?: any;
  }> {
    if (!schema || !schema.properties) {
      return [];
    }

    const required = schema.required || [];
    const params: Array<{
      name: string;
      type: string;
      required: boolean;
      description?: string;
      default?: any;
    }> = [];

    for (const [name, prop] of Object.entries(schema.properties)) {
      const propSchema = prop as any;

      params.push({
        name,
        type: Array.isArray(propSchema.type)
          ? propSchema.type.join(' | ')
          : propSchema.type || 'any',
        required: required.includes(name),
        description: propSchema.description,
        default: propSchema.default,
      });
    }

    return params;
  }
}
