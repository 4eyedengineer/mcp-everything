import {
  API_KEY_PLACEHOLDER,
  buildClaudeDesktopConfig,
  buildClaudeDesktopConfigJson,
  claudeDesktopApiKeyHint,
  slugifyServerName
} from './claude-desktop-config.util';

describe('claude-desktop-config.util', () => {
  describe('slugifyServerName', () => {
    it('lowercases and collapses whitespace to single hyphens', () => {
      expect(slugifyServerName('My   Cool   Server')).toBe('my-cool-server');
    });

    it('trims leading/trailing whitespace', () => {
      expect(slugifyServerName('  Padded Name  ')).toBe('padded-name');
    });

    it('leaves an already-slug-like name untouched', () => {
      expect(slugifyServerName('already-a-slug')).toBe('already-a-slug');
    });
  });

  describe('buildClaudeDesktopConfig', () => {
    it('emits the mcp-connect stdio shape keyed by the server id', () => {
      const config = buildClaudeDesktopConfig(
        'JSON Placeholder API',
        'jsonplaceholder-a1b2c3d4',
        'mcps_realkey'
      );

      expect(config).toEqual({
        mcpServers: {
          'json-placeholder-api': {
            command: 'mcp-connect',
            args: ['jsonplaceholder-a1b2c3d4'],
            env: { MCPEVERYTHING_API_KEY: 'mcps_realkey' }
          }
        }
      });
    });

    it('falls back to a conspicuous placeholder when no key is known', () => {
      // The real key is shown once at creation and is unrecoverable, so this
      // utility usually cannot know it. The snippet must not look ready to use.
      const config = buildClaudeDesktopConfig('My Server', 'my-server-xyz');

      expect(config.mcpServers['my-server'].env).toEqual({
        MCPEVERYTHING_API_KEY: API_KEY_PLACEHOLDER
      });
      expect(API_KEY_PLACEHOLDER).toContain('REPLACE');
    });

    it('never emits the deprecated sse transport/url shape', () => {
      const config = buildClaudeDesktopConfig('My Server', 'my-server-xyz');
      const entry = config.mcpServers['my-server'] as unknown as Record<string, unknown>;

      expect(entry['transport']).toBeUndefined();
      expect(entry['url']).toBeUndefined();
      expect(entry['command']).toBe('mcp-connect');
      expect(entry['args']).toEqual(['my-server-xyz']);
    });
  });

  describe('claudeDesktopApiKeyHint', () => {
    it('tells the user a key is needed, where to get it, and that it is shown once', () => {
      const hint = claudeDesktopApiKeyHint('my-server-xyz');

      expect(hint).toContain(API_KEY_PLACEHOLDER);
      expect(hint).toContain('/api/hosting/servers/my-server-xyz/keys');
      expect(hint).toMatch(/only once/i);
    });
  });

  describe('buildClaudeDesktopConfigJson', () => {
    it('pretty-prints the same object buildClaudeDesktopConfig returns', () => {
      const json = buildClaudeDesktopConfigJson('My Server', 'my-server-xyz');
      const parsed = JSON.parse(json);

      expect(parsed).toEqual(buildClaudeDesktopConfig('My Server', 'my-server-xyz'));
      expect(json).toContain('"command": "mcp-connect"');
    });
  });
});
