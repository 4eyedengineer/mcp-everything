/**
 * Typed errors thrown by {@link AnthropicService}.
 *
 * These exist so callers can branch on *why* a completion failed instead of
 * string-matching messages or silently "repairing" bad output.
 */

/** Base class for every error raised by the AI seam. */
export class AnthropicServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The model stopped because it hit `max_tokens`.
 *
 * The response is a partial, syntactically incomplete answer. We NEVER try to
 * repair it (no brace-balancing, no fabricated code) - the caller decides
 * whether to retry with a larger `maxTokens`, split the work, or give up.
 */
export class TruncatedResponseError extends AnthropicServiceError {
  readonly model: string;
  readonly maxTokens: number;
  readonly caller: string;
  /** Text produced before truncation. Useful for logs; not safe to use as-is. */
  readonly partialText: string;

  constructor(details: { model: string; maxTokens: number; caller: string; partialText: string }) {
    super(
      `Anthropic response truncated at max_tokens=${details.maxTokens} ` +
        `(model=${details.model}, caller=${details.caller}, ` +
        `${details.partialText.length} chars produced). Retry with a higher maxTokens.`,
    );
    this.model = details.model;
    this.maxTokens = details.maxTokens;
    this.caller = details.caller;
    this.partialText = details.partialText;
  }
}

/**
 * The model returned JSON that does not satisfy the requested zod schema,
 * even after one corrective retry.
 */
export class SchemaValidationError extends AnthropicServiceError {
  readonly schemaName: string;
  readonly model: string;
  readonly caller: string;
  readonly issues: string;
  readonly rawText: string;

  constructor(details: {
    schemaName: string;
    model: string;
    caller: string;
    issues: string;
    rawText: string;
  }) {
    super(
      `Anthropic structured output failed schema "${details.schemaName}" after retry ` +
        `(model=${details.model}, caller=${details.caller}): ${details.issues}`,
    );
    this.schemaName = details.schemaName;
    this.model = details.model;
    this.caller = details.caller;
    this.issues = details.issues;
    this.rawText = details.rawText;
  }
}

/**
 * Safety classifiers declined the request (HTTP 200 with
 * `stop_reason: "refusal"`). Retrying the same prompt will not help.
 */
export class AnthropicRefusalError extends AnthropicServiceError {
  readonly model: string;
  readonly caller: string;
  readonly category?: string;

  constructor(details: { model: string; caller: string; category?: string }) {
    super(
      `Anthropic declined the request (model=${details.model}, caller=${details.caller}` +
        `${details.category ? `, category=${details.category}` : ''}).`,
    );
    this.model = details.model;
    this.caller = details.caller;
    this.category = details.category;
  }
}
