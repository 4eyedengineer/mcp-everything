import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
// NOTE: schemas passed to `completeStructured` MUST be built with `zod/v4`
// (`import * as z from 'zod/v4'`). The JSON-Schema conversion below is the v4
// API; a classic `import { z } from 'zod'` schema will not convert.
import * as z from 'zod/v4';
import { MetricsService } from '../metrics/metrics.service';
import {
  AnthropicRefusalError,
  SchemaValidationError,
  TruncatedResponseError,
} from './anthropic.errors';

/**
 * Which configured model to use.
 * - `default` -> ANTHROPIC_MODEL (Sonnet 5): reasoning, synthesis, code generation
 * - `small`   -> ANTHROPIC_SMALL_MODEL (Haiku 4.5): cheap classification / extraction
 */
export type AnthropicModelTier = 'default' | 'small';

export interface CompleteTextOptions {
  /** The user-turn prompt. */
  prompt: string;
  /** Optional system prompt (kept stable across calls for prompt caching). */
  system?: string;
  /** Model tier. Defaults to `default`. */
  model?: AnthropicModelTier;
  /** Output cap (thinking + text). Defaults to ANTHROPIC_MAX_TOKENS. */
  maxTokens?: number;
  /** Label used for logs and metrics, e.g. `refinement.generateMainFile`. */
  caller?: string;
}

export interface CompleteStructuredOptions<T> extends CompleteTextOptions {
  /** zod/v4 schema the response must satisfy. */
  schema: z.ZodType<T>;
  /** Human-readable schema name, used in errors and logs. */
  schemaName: string;
}

interface CallResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * Per-million-token pricing, matched by model-id prefix (longest match wins).
 * Used for cost telemetry only - never for routing decisions.
 */
const MODEL_PRICING: Array<{ prefix: string; input: number; output: number }> = [
  { prefix: 'claude-fable-5', input: 10, output: 50 },
  { prefix: 'claude-mythos-5', input: 10, output: 50 },
  { prefix: 'claude-opus-5', input: 5, output: 25 },
  { prefix: 'claude-opus-4', input: 5, output: 25 },
  { prefix: 'claude-sonnet-5', input: 3, output: 15 },
  { prefix: 'claude-sonnet-4', input: 3, output: 15 },
  { prefix: 'claude-haiku-4', input: 1, output: 5 },
];

const DEFAULTS = {
  model: 'claude-sonnet-5',
  smallModel: 'claude-haiku-4-5',
  maxConcurrency: 4,
  timeoutMs: 120_000,
  maxRetries: 3,
  maxTokens: 8_192,
};

/**
 * The single seam between this backend and the Anthropic API.
 *
 * Everything that talks to Claude goes through here, which buys us one place to
 * configure models, one retry/timeout policy, one concurrency limit, and one
 * source of token/cost telemetry.
 *
 * Design notes:
 * - Every call is streamed (`messages.stream` + `finalMessage()`), so large
 *   `maxTokens` values cannot trip HTTP request timeouts.
 * - Structured output uses the API's native `output_config.format` JSON-schema
 *   mechanism. No assistant prefill, no "please return JSON" + regex, no
 *   bracket-balancing repair.
 * - Truncation surfaces as a typed {@link TruncatedResponseError} instead of
 *   being silently patched up.
 */
@Injectable()
export class AnthropicService {
  private readonly logger = new Logger(AnthropicService.name);
  private readonly client: Anthropic;

  private readonly defaultModel: string;
  private readonly smallModel: string;
  private readonly defaultMaxTokens: number;
  private readonly maxConcurrency: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  /** Concurrency gate state. */
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metricsService?: MetricsService,
  ) {
    const apiKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }

    this.defaultModel = this.configService.get<string>('ANTHROPIC_MODEL') || DEFAULTS.model;
    this.smallModel =
      this.configService.get<string>('ANTHROPIC_SMALL_MODEL') || DEFAULTS.smallModel;
    this.defaultMaxTokens = this.readNumber('ANTHROPIC_MAX_TOKENS', DEFAULTS.maxTokens);
    this.maxConcurrency = this.readNumber('ANTHROPIC_MAX_CONCURRENCY', DEFAULTS.maxConcurrency);
    this.timeoutMs = this.readNumber('ANTHROPIC_TIMEOUT_MS', DEFAULTS.timeoutMs);
    this.maxRetries = this.readNumber('ANTHROPIC_MAX_RETRIES', DEFAULTS.maxRetries);

    this.client = new Anthropic({
      apiKey,
      // SDK-native retries with exponential backoff (429 / 408 / 409 / 5xx /
      // connection errors).
      maxRetries: this.maxRetries,
      timeout: this.timeoutMs,
    });

    this.logger.log(
      `AnthropicService ready (model=${this.defaultModel}, small=${this.smallModel}, ` +
        `maxTokens=${this.defaultMaxTokens}, concurrency=${this.maxConcurrency}, ` +
        `timeout=${this.timeoutMs}ms, retries=${this.maxRetries}, ` +
        `metrics=${this.metricsService ? 'on' : 'off'})`,
    );
  }

  /** Resolve a tier to the configured model id. */
  resolveModel(tier: AnthropicModelTier = 'default'): string {
    return tier === 'small' ? this.smallModel : this.defaultModel;
  }

  /**
   * Plain text completion.
   *
   * @throws TruncatedResponseError if the model hit `maxTokens`.
   * @throws AnthropicRefusalError if safety classifiers declined the request.
   */
  async completeText(opts: CompleteTextOptions): Promise<string> {
    const result = await this.call(opts);
    return result.text;
  }

  /**
   * Schema-validated completion using the API's structured-output mechanism.
   *
   * On a validation failure the prompt is retried once with the validation
   * error appended; a second failure throws {@link SchemaValidationError}.
   */
  async completeStructured<T>(opts: CompleteStructuredOptions<T>): Promise<T> {
    const jsonSchema = this.toJsonSchema(opts.schema, opts.schemaName);

    let attemptPrompt = opts.prompt;
    let lastIssues = '';
    let lastText = '';

    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = await this.call({ ...opts, prompt: attemptPrompt }, jsonSchema);
      lastText = result.text;

      const parsed = this.safeParse(opts.schema, result.text);
      if (parsed.ok) {
        return parsed.value as T;
      }

      lastIssues = parsed.issues;
      this.logger.warn(
        `Structured output failed schema "${opts.schemaName}" on attempt ${attempt}` +
          `${attempt === 1 ? ', retrying with validation feedback' : ''}: ${parsed.issues}`,
      );

      attemptPrompt =
        `${opts.prompt}\n\n` +
        `**Your previous response was rejected by schema validation:**\n` +
        `${parsed.issues}\n\n` +
        `Return a JSON value that satisfies the schema exactly. Do not add commentary.`;
    }

    throw new SchemaValidationError({
      schemaName: opts.schemaName,
      model: this.resolveModel(opts.model),
      caller: opts.caller || 'unknown',
      issues: lastIssues,
      rawText: lastText,
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async call(
    opts: CompleteTextOptions,
    jsonSchema?: Record<string, unknown>,
  ): Promise<CallResult> {
    const model = this.resolveModel(opts.model);
    const maxTokens = opts.maxTokens ?? this.defaultMaxTokens;
    const caller = opts.caller || 'unknown';
    const startedAt = Date.now();

    const release = await this.acquire();
    try {
      const stream = this.client.messages.stream(
        {
          model,
          max_tokens: maxTokens,
          ...(opts.system ? { system: opts.system } : {}),
          ...(jsonSchema
            ? {
                output_config: {
                  format: { type: 'json_schema' as const, schema: jsonSchema },
                },
              }
            : {}),
          messages: [{ role: 'user' as const, content: opts.prompt }],
        },
        { timeout: this.timeoutMs },
      );

      const message = await stream.finalMessage();

      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const inputTokens =
        (message.usage?.input_tokens ?? 0) +
        (message.usage?.cache_read_input_tokens ?? 0) +
        (message.usage?.cache_creation_input_tokens ?? 0);
      const outputTokens = message.usage?.output_tokens ?? 0;
      const costUsd = this.estimateCost(model, inputTokens, outputTokens);

      this.recordTelemetry({
        caller,
        model,
        status: message.stop_reason === 'max_tokens' ? 'truncated' : 'success',
        inputTokens,
        outputTokens,
        costUsd,
        latencyMs: Date.now() - startedAt,
        extra: `stop_reason=${message.stop_reason}`,
      });

      if (message.stop_reason === 'refusal') {
        throw new AnthropicRefusalError({
          model,
          caller,
          category: (message as any).stop_details?.category ?? undefined,
        });
      }

      // Never repair a truncated response - hand the decision back to the caller.
      if (message.stop_reason === 'max_tokens') {
        throw new TruncatedResponseError({ model, maxTokens, caller, partialText: text });
      }

      return { text, model, inputTokens, outputTokens, costUsd };
    } catch (error) {
      if (!(error instanceof TruncatedResponseError) && !(error instanceof AnthropicRefusalError)) {
        this.recordTelemetry({
          caller,
          model,
          status: 'error',
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - startedAt,
          extra: `error=${error instanceof Error ? error.message : String(error)}`,
        });
      }
      throw error;
    } finally {
      release();
    }
  }

  /** Convert a zod/v4 schema to the JSON Schema the API expects. */
  private toJsonSchema(schema: z.ZodType<unknown>, schemaName: string): Record<string, unknown> {
    try {
      const jsonSchema = z.toJSONSchema(schema, { io: 'output' }) as Record<string, unknown>;
      // `$schema` is metadata the structured-output validator does not want.
      delete jsonSchema.$schema;
      return jsonSchema;
    } catch (error) {
      throw new Error(
        `Failed to convert schema "${schemaName}" to JSON Schema ` +
          `(schemas must be built with zod/v4): ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }

  private safeParse<T>(
    schema: z.ZodType<T>,
    text: string,
  ): { ok: boolean; value?: T; issues?: string } {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      return {
        ok: false,
        issues: `response was not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }

    const result = schema.safeParse(json);
    if (result.success) {
      return { ok: true, value: result.data };
    }

    const issues = result.error.issues
      .slice(0, 10)
      .map((issue) => `- ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    return { ok: false, issues };
  }

  private estimateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = MODEL_PRICING.filter((entry) => model.startsWith(entry.prefix)).sort(
      (a, b) => b.prefix.length - a.prefix.length,
    )[0];
    if (!pricing) {
      return 0;
    }
    return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
  }

  private recordTelemetry(entry: {
    caller: string;
    model: string;
    status: 'success' | 'truncated' | 'error';
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    latencyMs: number;
    extra?: string;
  }): void {
    this.logger.debug(
      `ai call caller=${entry.caller} model=${entry.model} status=${entry.status} ` +
        `in=${entry.inputTokens} out=${entry.outputTokens} ` +
        `cost=$${entry.costUsd.toFixed(6)} latency=${entry.latencyMs}ms` +
        `${entry.extra ? ` ${entry.extra}` : ''}`,
    );

    if (!this.metricsService) {
      return;
    }

    try {
      this.metricsService.recordAiCall({
        caller: entry.caller,
        model: entry.model,
        status: entry.status,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        costUsd: entry.costUsd,
      });
    } catch (error) {
      // Telemetry must never break a completion.
      this.logger.debug(
        `Failed to record AI metrics: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Simple counting semaphore: resolves to the release function. */
  private async acquire(): Promise<() => void> {
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight++;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.inFlight--;
      const next = this.waiters.shift();
      if (next) {
        next();
      }
    };
  }

  private readNumber(key: string, fallback: number): number {
    const raw = this.configService.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') {
      return fallback;
    }
    const parsed = typeof raw === 'number' ? raw : parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.logger.warn(`Invalid ${key}="${raw}", falling back to ${fallback}`);
      return fallback;
    }
    return parsed;
  }
}
