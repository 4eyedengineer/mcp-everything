/// <reference types="jest" />
import * as z from 'zod/v4';
import { AnthropicService } from './anthropic.service';
import { TruncatedResponseError, AnthropicRefusalError } from './anthropic.errors';

/**
 * Config double: a Map-backed stand-in for NestJS ConfigService supporting
 * both `get(key)` and `get(key, default)`.
 */
function fakeConfig(values: Record<string, string>) {
  return {
    get: (key: string, def?: unknown) => (key in values ? values[key] : def),
  } as any;
}

/** Builds a fake OpenRouter (OpenAI-compatible) client whose streamed
 * completion yields the given content deltas then a final usage chunk. */
function fakeOpenRouterClient(opts: {
  contentChunks: string[];
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  model?: string;
}) {
  const create = jest.fn(async (_params: any, _opts?: any) => {
    async function* gen() {
      for (const c of opts.contentChunks) {
        yield { model: opts.model, choices: [{ delta: { content: c } }] };
      }
      yield {
        model: opts.model,
        choices: [{ delta: {}, finish_reason: opts.finishReason ?? 'stop' }],
      };
      if (opts.usage) {
        yield { model: opts.model, choices: [], usage: opts.usage };
      }
    }
    return gen();
  });
  return { create, client: { chat: { completions: { create } } } };
}

describe('AnthropicService provider routing', () => {
  describe('config + resolveTarget', () => {
    it('defaults both tiers to Anthropic and requires only the Anthropic key', () => {
      const svc = new AnthropicService(fakeConfig({ ANTHROPIC_API_KEY: 'sk-ant' }));
      expect(svc.resolveTarget('default')).toEqual({
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      });
      expect(svc.resolveTarget('small')).toEqual({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      });
    });

    it('routes the small tier to OpenRouter DeepSeek when configured', () => {
      const svc = new AnthropicService(
        fakeConfig({
          ANTHROPIC_API_KEY: 'sk-ant',
          AI_SMALL_PROVIDER: 'openrouter',
          OPENROUTER_API_KEY: 'sk-or',
        }),
      );
      expect(svc.resolveTarget('small')).toEqual({
        provider: 'openrouter',
        model: 'deepseek/deepseek-v4-flash',
      });
      // Default tier is untouched.
      expect(svc.resolveTarget('default').provider).toBe('anthropic');
    });

    it('honors explicit OpenRouter model overrides', () => {
      const svc = new AnthropicService(
        fakeConfig({
          AI_DEFAULT_PROVIDER: 'openrouter',
          AI_SMALL_PROVIDER: 'openrouter',
          AI_DEFAULT_MODEL_OPENROUTER: 'qwen/qwen3-coder-plus',
          AI_SMALL_MODEL_OPENROUTER: 'qwen/qwen3-30b-a3b-instruct-2507',
          OPENROUTER_API_KEY: 'sk-or',
        }),
      );
      expect(svc.resolveTarget('default').model).toBe('qwen/qwen3-coder-plus');
      expect(svc.resolveTarget('small').model).toBe('qwen/qwen3-30b-a3b-instruct-2507');
    });

    it('runs OpenRouter-only without an Anthropic key', () => {
      expect(
        () =>
          new AnthropicService(
            fakeConfig({
              AI_DEFAULT_PROVIDER: 'openrouter',
              AI_SMALL_PROVIDER: 'openrouter',
              OPENROUTER_API_KEY: 'sk-or',
            }),
          ),
      ).not.toThrow();
    });

    it('fails fast when a tier is routed to OpenRouter without a key', () => {
      expect(
        () =>
          new AnthropicService(
            fakeConfig({ ANTHROPIC_API_KEY: 'sk-ant', AI_SMALL_PROVIDER: 'openrouter' }),
          ),
      ).toThrow(/OPENROUTER_API_KEY/);
    });

    it('fails fast when a tier needs Anthropic but no key is set', () => {
      expect(() => new AnthropicService(fakeConfig({}))).toThrow(/ANTHROPIC_API_KEY/);
    });

    it('falls back to anthropic on an invalid provider value', () => {
      const svc = new AnthropicService(
        fakeConfig({ ANTHROPIC_API_KEY: 'sk-ant', AI_DEFAULT_PROVIDER: 'bogus' }),
      );
      expect(svc.resolveTarget('default').provider).toBe('anthropic');
    });
  });

  describe('OpenRouter wire path', () => {
    function makeService() {
      return new AnthropicService(
        fakeConfig({
          AI_DEFAULT_PROVIDER: 'openrouter',
          AI_SMALL_PROVIDER: 'openrouter',
          OPENROUTER_API_KEY: 'sk-or',
        }),
      );
    }

    it('concatenates streamed content and prefers OpenRouter reported cost', async () => {
      const svc = makeService();
      const fake = fakeOpenRouterClient({
        contentChunks: ['Hello ', 'world'],
        usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.000456 },
        model: 'deepseek/deepseek-v4-flash',
      });
      (svc as any).openRouterClient = fake.client;

      const text = await svc.completeText({ prompt: 'hi', caller: 'test' });

      expect(text).toBe('Hello world');
      // System prompt omitted -> only the user message is sent.
      const params = fake.create.mock.calls[0][0];
      expect(params.messages).toEqual([{ role: 'user', content: 'hi' }]);
      expect(params.usage).toEqual({ include: true });
      expect(params.stream).toBe(true);
    });

    it('includes a system message when provided', async () => {
      const svc = makeService();
      const fake = fakeOpenRouterClient({ contentChunks: ['ok'] });
      (svc as any).openRouterClient = fake.client;

      await svc.completeText({ prompt: 'u', system: 's', caller: 'test' });

      expect(fake.create.mock.calls[0][0].messages).toEqual([
        { role: 'system', content: 's' },
        { role: 'user', content: 'u' },
      ]);
    });

    it('maps finish_reason=length to a TruncatedResponseError', async () => {
      const svc = makeService();
      const fake = fakeOpenRouterClient({
        contentChunks: ['partial'],
        finishReason: 'length',
      });
      (svc as any).openRouterClient = fake.client;

      await expect(svc.completeText({ prompt: 'hi', caller: 'test' })).rejects.toBeInstanceOf(
        TruncatedResponseError,
      );
    });

    it('maps finish_reason=content_filter to an AnthropicRefusalError', async () => {
      const svc = makeService();
      const fake = fakeOpenRouterClient({
        contentChunks: [''],
        finishReason: 'content_filter',
      });
      (svc as any).openRouterClient = fake.client;

      await expect(svc.completeText({ prompt: 'hi', caller: 'test' })).rejects.toBeInstanceOf(
        AnthropicRefusalError,
      );
    });

    it('sends a json_schema response_format and validates structured output', async () => {
      const svc = makeService();
      const schema = z.object({ ok: z.boolean(), n: z.number() });
      const fake = fakeOpenRouterClient({
        contentChunks: [JSON.stringify({ ok: true, n: 7 })],
        usage: { prompt_tokens: 5, completion_tokens: 4, cost: 0.0001 },
      });
      (svc as any).openRouterClient = fake.client;

      const out = await svc.completeStructured({
        prompt: 'give me json',
        schema,
        schemaName: 'Thing',
        caller: 'test',
      });

      expect(out).toEqual({ ok: true, n: 7 });
      const params = fake.create.mock.calls[0][0];
      expect(params.response_format.type).toBe('json_schema');
      expect(params.response_format.json_schema.name).toBe('structured_output');
      expect(params.response_format.json_schema.schema).toBeDefined();
    });
  });
});
