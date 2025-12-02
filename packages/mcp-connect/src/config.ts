import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface Config {
  baseUrl?: string;
  apiKeys?: Record<string, string>;
}

const CONFIG_PATHS = [
  path.join(os.homedir(), '.mcpeverything', 'config.json'),
  path.join(os.homedir(), '.config', 'mcpeverything', 'config.json'),
];

export function loadConfig(): Config {
  for (const configPath of CONFIG_PATHS) {
    if (fs.existsSync(configPath)) {
      try {
        const content = fs.readFileSync(configPath, 'utf-8');
        return JSON.parse(content);
      } catch (error) {
        // Invalid config file, continue to next
        console.error(`Warning: Could not parse config at ${configPath}`);
      }
    }
  }

  return {};
}

export function saveConfig(config: Config): void {
  const configDir = path.join(os.homedir(), '.mcpeverything');

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function getConfigPath(): string {
  return path.join(os.homedir(), '.mcpeverything', 'config.json');
}
