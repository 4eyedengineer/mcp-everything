/**
 * Simple logger interface for JSON parsing
 * Compatible with both NestJS Logger and StructuredLoggerService
 */
export interface SimpleLogger {
  warn(message: string, context?: any): void;
  log(message: string, context?: any): void;
  error(message: string, trace?: string, context?: any): void;
}

/**
 * Safely extract and parse JSON from an LLM response
 * Uses bracket balancing to find the first complete JSON object
 *
 * This fixes the issue where the greedy regex \{[\s\S]*\} matches from
 * the first { to the last }, potentially including extra text.
 */
export function safeParseJSON<T>(text: string, logger?: SimpleLogger): T {
  // Remove markdown code blocks if present
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

  // Find the first { and balance brackets to find the matching }
  const startIndex = cleaned.indexOf('{');
  if (startIndex === -1) {
    throw new Error('No JSON object found in response');
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let endIndex = -1;

  for (let i = startIndex; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    if (char === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          endIndex = i;
          break;
        }
      }
    }
  }

  if (endIndex === -1) {
    // Try recovery: LLM response may be truncated - attempt to find last } and close remaining brackets
    if (logger) {
      logger.warn('Attempting to recover truncated JSON response');
    }

    // Find the last } in the string
    const lastBrace = cleaned.lastIndexOf('}');
    if (lastBrace > startIndex) {
      // Try to close any remaining open brackets by counting
      let openBraces = 0;
      for (let i = startIndex; i <= lastBrace; i++) {
        const char = cleaned[i];
        if (char === '"') {
          // Skip strings
          i++;
          while (i < lastBrace && cleaned[i] !== '"') {
            if (cleaned[i] === '\\') i++;
            i++;
          }
        } else if (char === '{') {
          openBraces++;
        } else if (char === '}') {
          openBraces--;
        }
      }

      // Append missing closing braces
      let recovered = cleaned.substring(startIndex, lastBrace + 1);
      for (let i = 0; i < openBraces; i++) {
        recovered += '}';
      }

      try {
        const parsed = JSON.parse(recovered);
        if (logger) {
          logger.log('Successfully recovered truncated JSON');
        }
        return parsed as T;
      } catch (e) {
        // Recovery failed
      }
    }

    throw new Error('Unbalanced JSON brackets in response');
  }

  const jsonString = cleaned.substring(startIndex, endIndex + 1);

  try {
    return JSON.parse(jsonString) as T;
  } catch (e) {
    // Log the problematic JSON for debugging
    if (logger) {
      logger.error(`Failed to parse JSON: ${e.message}`);
      logger.error(`JSON string (first 500 chars): ${jsonString.substring(0, 500)}`);
    }
    throw new Error(`JSON parse error: ${e.message}`);
  }
}

/**
 * Extract JSON array from LLM response using bracket balancing
 */
export function safeParseJSONArray<T>(text: string, logger?: SimpleLogger): T[] {
  // Remove markdown code blocks if present
  let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');

  // Find the first [ and balance brackets to find the matching ]
  const startIndex = cleaned.indexOf('[');
  if (startIndex === -1) {
    throw new Error('No JSON array found in response');
  }

  let depth = 0;
  let inString = false;
  let escape = false;
  let endIndex = -1;

  for (let i = startIndex; i < cleaned.length; i++) {
    const char = cleaned[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    if (char === '"' && !escape) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '[' || char === '{') {
        depth++;
      } else if (char === ']' || char === '}') {
        depth--;
        if (depth === 0 && char === ']') {
          endIndex = i;
          break;
        }
      }
    }
  }

  if (endIndex === -1) {
    throw new Error('Unbalanced JSON array brackets in response');
  }

  const jsonString = cleaned.substring(startIndex, endIndex + 1);

  try {
    return JSON.parse(jsonString) as T[];
  } catch (e) {
    if (logger) {
      logger.error(`Failed to parse JSON array: ${e.message}`);
      logger.error(`JSON string (first 500 chars): ${jsonString.substring(0, 500)}`);
    }
    throw new Error(`JSON array parse error: ${e.message}`);
  }
}
