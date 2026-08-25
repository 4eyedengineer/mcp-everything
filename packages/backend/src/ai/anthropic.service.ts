import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
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
 * - `default` -> reasoning, synthesis, code generation (the quality-critical path)
 * - `small`   -> cheap classification / extraction (high volume, low risk)
 *
 * Each tier resolves to a (provider, model) target via `resolveTarget`. The
 * concrete model behind a tier depends on that tier's configured provider:
 * Anthropic (`ANTHROPIC_MODEL` / `ANTHROPIC_SMALL_MODEL`) or OpenRouter
 * (`AI_DEFAULT_MODEL_OPENROUTER` / `AI_SMALL_MODEL_OPENROUTER`). See
 * `LlmProvider` and the constructor.
 */
export type AnthropicModelTier = 'default' | 'small';

/**
 * Which upstream a tier is routed to. `anthropic` calls the Anthropic Messages
 * API directly; `openrouter` calls OpenRouter's OpenAI-compatible endpoint
 * (`https://openrouter.ai/api/v1`), which fronts hundreds of models (DeepSeek,
 * Qwen, Gemini, and Anthropic's own, among others) behind one key.
 *
 * Both tiers default to `anthropic`, so adding OpenRouter support changes no
 * behavior until a tier's provider is explicitly set. Routing is a config
 * decision (cost vs. quality), never inferred here.
 */
export type LlmProvider = 'anthropic' | 'openrouter';

/** A tier resolved to the concrete upstream it will call. */
interface ResolvedTarget {
  provider: LlmProvider;
  model: string;
}

/**
 * Provider-neutral result of one wire call, before it is turned into a
 * `CallResult` (or a typed error). `stopReason` is normalized across the two
 * providers' different vocabularies (`stop_reason` vs `finish_reason`) so the
 * truncation/refusal handling in `call()` stays provider-agnostic.
 */
interface RawCompletion {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  stopReason: 'end' | 'max_tokens' | 'refusal';
  stopDetail?: string;
}

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
  // OpenRouter fallbacks (per-million USD, as of 2026-08). Only used when a
  // response does not carry OpenRouter's own `usage.cost` - which it does
  // whenever we ask for it (see callOpenRouterRaw), so these are a safety net,
  // not the primary source of truth. Matched on the full `provider/model` slug.
  { prefix: 'deepseek/deepseek-v4-flash', input: 0.083, output: 0.165 },
  { prefix: 'qwen/qwen3-coder', input: 0.3, output: 1.0 },
];

const DEFAULTS = {
  model: 'claude-sonnet-5',
  smallModel: 'claude-haiku-4-5',
  // OpenRouter model ids used only when a tier's provider is set to
  // `openrouter` and no explicit override is configured. Chosen for a strong
  // price/quality ratio: DeepSeek V4 Flash for cheap high-volume small-tier
  // work, Qwen3 Coder for code generation.
  openRouterModel: 'qwen/qwen3-coder',
  openRouterSmallModel: 'deepseek/deepseek-v4-flash',
  maxConcurrency: 4,
  timeoutMs: 120_000,
  maxRetries: 3,
  maxTokens: 8_192,
};

/** OpenRouter's OpenAI-compatible base URL. */
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

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
  /** Built only when some tier routes to Anthropic (the default). */
  private readonly client?: Anthropic;
  /** Built only when OPENROUTER_API_KEY is configured. */
  private readonly openRouterClient?: OpenAI;

  private readonly defaultModel: string;
  private readonly smallModel: string;
  private readonly defaultProvider: LlmProvider;
  private readonly smallProvider: LlmProvider;
  private readonly openRouterModel: string;
  private readonly openRouterSmallModel: string;
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
    this.defaultMaxTokens = this.readNumber('ANTHROPIC_MAX_TOKENS', DEFAULTS.maxTokens);
    this.maxConcurrency = this.readNumber('ANTHROPIC_MAX_CONCURRENCY', DEFAULTS.maxConcurrency);
    this.timeoutMs = this.readNumber('ANTHROPIC_TIMEOUT_MS', DEFAULTS.timeoutMs);
    this.maxRetries = this.readNumber('ANTHROPIC_MAX_RETRIES', DEFAULTS.maxRetries);

    // Per-tier routing. Both default to Anthropic, so this whole block is a
    // no-op for an unconfigured deployment.
    this.defaultProvider = this.readProvider('AI_DEFAULT_PROVIDER');
    this.smallProvider = this.readProvider('AI_SMALL_PROVIDER');

    this.defaultModel = this.configService.get<string>('ANTHROPIC_MODEL') || DEFAULTS.model;
    this.smallModel =
      this.configService.get<string>('ANTHROPIC_SMALL_MODEL') || DEFAULTS.smallModel;
    this.openRouterModel =
      this.configService.get<string>('AI_DEFAULT_MODEL_OPENROUTER') || DEFAULTS.openRouterModel;
    this.openRouterSmallModel =
      this.configService.get<string>('AI_SMALL_MODEL_OPENROUTER') || DEFAULTS.openRouterSmallModel;

    // Build the Anthropic client only if some tier actually needs it. This lets
    // a deployment run OpenRouter-only without a (now-unused) ANTHROPIC_API_KEY.
    const needAnthropic =
      this.defaultProvider === 'anthropic' || this.smallProvider === 'anthropic';
    const anthropicKey = this.configService.get<string>('ANTHROPIC_API_KEY');
    if (needAnthropic && !anthropicKey) {
      throw new Error(
        'ANTHROPIC_API_KEY not configured (required because a model tier is routed to Anthropic; ' +
          'set AI_DEFAULT_PROVIDER and AI_SMALL_PROVIDER to openrouter to run without it)',
      );
    }
    if (anthropicKey) {
      this.client = new Anthropic({
        apiKey: anthropicKey,
        // SDK-native retries with exponential backoff (429 / 408 / 409 / 5xx /
        // connection errors).
        maxRetries: this.maxRetries,
        timeout: this.timeoutMs,
      });
    }

    // Build the OpenRouter client whenever a key is present, and fail fast if a
    // tier is routed to it without one - a silent fallback to Anthropic would
    // bill the pricey path exactly when the operator expected the cheap one.
    const openRouterKey = this.configService.get<string>('OPENROUTER_API_KEY');
    const needOpenRouter =
      this.defaultProvider === 'openrouter' || this.smallProvider === 'openrouter';
    if (needOpenRouter && !openRouterKey) {
      throw new Error(
        'A model tier is routed to OpenRouter (AI_*_PROVIDER=openrouter) but OPENROUTER_API_KEY ' +
          'is not configured',
      );
    }
    if (openRouterKey) {
      this.openRouterClient = new OpenAI({
        apiKey: openRouterKey,
        baseURL: OPENROUTER_BASE_URL,
        maxRetries: this.maxRetries,
        timeout: this.timeoutMs,
        // OpenRouter attributes traffic and populates its dashboards/rankings
        // from these; neither is required, both are safe to send.
        defaultHeaders: {
          'HTTP-Referer': this.configService.get<string>(
            'OPENROUTER_SITE_URL',
            'https://mcp-everything.dev',
          ),
          'X-Title': 'MCP Everything',
        },
      });
    }

    const describe = (provider: LlmProvider, tier: AnthropicModelTier) =>
      `${provider}:${this.resolveTarget(tier).model}`;
    this.logger.log(
      `AnthropicService ready (default=${describe(this.defaultProvider, 'default')}, ` +
        `small=${describe(this.smallProvider, 'small')}, ` +
        `maxTokens=${this.defaultMaxTokens}, concurrency=${this.maxConcurrency}, ` +
        `timeout=${this.timeoutMs}ms, retries=${this.maxRetries}, ` +
        `metrics=${this.metricsService ? 'on' : 'off'})`,
    );
  }

  /** Resolve a tier to the concrete model id it will call (across providers). */
  resolveModel(tier: AnthropicModelTier = 'default'): string {
    return this.resolveTarget(tier).model;
  }

  /** Resolve a tier to its (provider, model) target. */
  resolveTarget(tier: AnthropicModelTier = 'default'): ResolvedTarget {
    if (tier === 'small') {
      return this.smallProvider === 'openrouter'
        ? { provider: 'openrouter', model: this.openRouterSmallModel }
        : { provider: 'anthropic', model: this.smallModel };
    }
    return this.defaultProvider === 'openrouter'
      ? { provider: 'openrouter', model: this.openRouterModel }
      : { provider: 'anthropic', model: this.defaultModel };
  }

  /** Read + validate an AI_*_PROVIDER config value, defaulting to anthropic. */
  private readProvider(key: string): LlmProvider {
    const raw = (this.configService.get<string>(key) || '').trim().toLowerCase();
    if (raw === 'openrouter') {
      return 'openrouter';
    }
    if (raw && raw !== 'anthropic') {
      this.logger.warn(`Invalid ${key}="${raw}", falling back to "anthropic"`);
    }
    return 'anthropic';
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
    const { provider, model } = this.resolveTarget(opts.model);
    const maxTokens = opts.maxTokens ?? this.defaultMaxTokens;
    const caller = opts.caller || 'unknown';
    const startedAt = Date.now();

    const release = await this.acquire();
    try {
      const raw =
        provider === 'openrouter'
          ? await this.callOpenRouterRaw(model, opts, maxTokens, jsonSchema)
          : await this.callAnthropicRaw(model, opts, maxTokens, jsonSchema);

      this.recordTelemetry({
        caller,
        model: raw.model,
        status: raw.stopReason === 'max_tokens' ? 'truncated' : 'success',
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        costUsd: raw.costUsd,
        latencyMs: Date.now() - startedAt,
        extra: `provider=${provider} stop=${raw.stopReason}${
          raw.stopDetail ? `:${raw.stopDetail}` : ''
        }`,
      });

      if (raw.stopReason === 'refusal') {
        throw new AnthropicRefusalError({ model: raw.model, caller, category: raw.stopDetail });
      }

      // Never repair a truncated response - hand the decision back to the caller.
      if (raw.stopReason === 'max_tokens') {
        throw new TruncatedResponseError({
          model: raw.model,
          maxTokens,
          caller,
          partialText: raw.text,
        });
      }

      return {
        text: raw.text,
        model: raw.model,
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        costUsd: raw.costUsd,
      };
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
          extra: `provider=${provider} error=${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      throw error;
    } finally {
      release();
    }
  }

  /**
   * One completion against the Anthropic Messages API. Streamed (so large
   * `maxTokens` cannot trip an HTTP timeout) and using the API's native
   * `output_config.format` JSON-schema mechanism for structured output.
   */
  private async callAnthropicRaw(
    model: string,
    opts: CompleteTextOptions,
    maxTokens: number,
    jsonSchema?: Record<string, unknown>,
  ): Promise<RawCompletion> {
    if (!this.client) {
      throw new Error('Anthropic provider selected but ANTHROPIC_API_KEY is not configured');
    }

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

    return {
      text,
      model,
      inputTokens,
      outputTokens,
      costUsd: this.estimateCost(model, inputTokens, outputTokens),
      stopReason:
        message.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : message.stop_reason === 'refusal'
            ? 'refusal'
            : 'end',
      stopDetail:
        message.stop_reason === 'refusal'
          ? ((message as any).stop_details?.category ?? undefined)
          : undefined,
    };
  }

  /**
   * One completion against OpenRouter's OpenAI-compatible endpoint. Streamed
   * for the same timeout reason as the Anthropic path, with `include_usage` so
   * the final chunk carries token counts and - because we pass OpenRouter's
   * `usage: { include: true }` - the REAL dollar cost of the call, which is
   * preferred over the local pricing table.
   *
   * Structured output uses OpenAI's `response_format: json_schema` (non-strict:
   * not every OpenRouter-fronted model honors strict mode, and `completeStructured`
   * already validates + retries, so a loose schema hint plus that safety net is
   * more robust than demanding strict adherence the provider may reject).
   */
  private async callOpenRouterRaw(
    model: string,
    opts: CompleteTextOptions,
    maxTokens: number,
    jsonSchema?: Record<string, unknown>,
  ): Promise<RawCompletion> {
    if (!this.openRouterClient) {
      throw new Error('OpenRouter provider selected but OPENROUTER_API_KEY is not configured');
    }

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (opts.system) {
      messages.push({ role: 'system', content: opts.system });
    }
    messages.push({ role: 'user', content: opts.prompt });

    // `usage` is an OpenRouter extension (not in the OpenAI SDK types), so the
    // params object is widened to carry it alongside the standard fields.
    const params = {
      model,
      max_tokens: maxTokens,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      usage: { include: true },
      ...(jsonSchema
        ? {
            response_format: {
              type: 'json_schema' as const,
              json_schema: { name: 'structured_output', strict: false, schema: jsonSchema },
            },
          }
        : {}),
    } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming;

    const stream = await this.openRouterClient.chat.completions.create(params, {
      timeout: this.timeoutMs,
    });

    let text = '';
    let finishReason: string | null = null;
    let usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number } | null = null;
    let resolvedModel = model;

    for await (const chunk of stream) {
      if (chunk.model) {
        resolvedModel = chunk.model;
      }
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content) {
        text += choice.delta.content;
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (chunk.usage) {
        usage = chunk.usage as typeof usage;
      }
    }

    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    // OpenRouter reports the exact charge in `usage.cost` (USD); fall back to
    // the local table only if it is somehow absent.
    const costUsd =
      typeof usage?.cost === 'number'
        ? usage.cost
        : this.estimateCost(model, inputTokens, outputTokens);

    return {
      text,
      model: resolvedModel,
      inputTokens,
      outputTokens,
      costUsd,
      stopReason:
        finishReason === 'length'
          ? 'max_tokens'
          : finishReason === 'content_filter'
            ? 'refusal'
            : 'end',
      stopDetail: finishReason ?? undefined,
    };
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
