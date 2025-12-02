import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fs module before importing config
jest.mock('fs');
const mockFs = fs as jest.Mocked<typeof fs>;

import { loadConfig, saveConfig, getConfigPath, Config } from '../src/config';
import { getApiKey } from '../src/auth';

describe('Config Module', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe('loadConfig', () => {
    it('should return empty object when no config file exists', () => {
      mockFs.existsSync.mockReturnValue(false);

      const config = loadConfig();

      expect(config).toEqual({});
    });

    it('should load config from primary path', () => {
      const expectedConfig: Config = {
        baseUrl: 'https://custom.mcp.com',
        apiKeys: { default: 'test-key' },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(expectedConfig));

      const config = loadConfig();

      expect(config).toEqual(expectedConfig);
    });

    it('should return empty object on invalid JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue('invalid json');

      // Suppress console.error for this test
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      const config = loadConfig();

      expect(config).toEqual({});
      consoleSpy.mockRestore();
    });
  });

  describe('saveConfig', () => {
    it('should create config directory if it does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      mockFs.mkdirSync.mockImplementation();
      mockFs.writeFileSync.mockImplementation();

      const config: Config = { baseUrl: 'https://test.com' };
      saveConfig(config);

      expect(mockFs.mkdirSync).toHaveBeenCalled();
      const mkdirCall = mockFs.mkdirSync.mock.calls[0];
      expect(mkdirCall[0].toString()).toContain('.mcpeverything');
      expect(mkdirCall[1]).toEqual({ recursive: true });
    });

    it('should write config as formatted JSON', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.writeFileSync.mockImplementation();

      const config: Config = { baseUrl: 'https://test.com' };
      saveConfig(config);

      expect(mockFs.writeFileSync).toHaveBeenCalled();
      const writeCall = mockFs.writeFileSync.mock.calls[0];
      expect(writeCall[0].toString()).toContain('config.json');
      expect(writeCall[1]).toEqual(JSON.stringify(config, null, 2));
    });
  });

  describe('getConfigPath', () => {
    it('should return path in home directory', () => {
      const configPath = getConfigPath();

      expect(configPath).toContain('.mcpeverything');
      expect(configPath).toContain('config.json');
    });
  });
});

describe('Auth Module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    delete process.env.MCPEVERYTHING_API_KEY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should prefer environment variable over config', () => {
    process.env.MCPEVERYTHING_API_KEY = 'env-key';
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ apiKeys: { default: 'config-key' } })
    );

    const apiKey = getApiKey('test-server');

    expect(apiKey).toBe('env-key');
  });

  it('should use server-specific key from config', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({
        apiKeys: {
          default: 'default-key',
          'test-server': 'server-specific-key',
        },
      })
    );

    const apiKey = getApiKey('test-server');

    expect(apiKey).toBe('server-specific-key');
  });

  it('should fall back to default key', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(
      JSON.stringify({ apiKeys: { default: 'default-key' } })
    );

    const apiKey = getApiKey('unknown-server');

    expect(apiKey).toBe('default-key');
  });

  it('should return undefined when no key is configured', () => {
    mockFs.existsSync.mockReturnValue(false);

    const apiKey = getApiKey('test-server');

    expect(apiKey).toBeUndefined();
  });
});

describe('StdioTransport', () => {
  // Transport tests would require more complex mocking of fetch and WebSocket
  // For now, we test the basic structure
  it('should be importable', () => {
    const { StdioTransport } = require('../src/transport');
    expect(StdioTransport).toBeDefined();
  });
});
