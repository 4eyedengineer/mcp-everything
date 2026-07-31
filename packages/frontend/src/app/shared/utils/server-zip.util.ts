import * as JSZip from 'jszip';

/** Shape of the generated-code payload attached to assistant messages. */
export interface GeneratedServerCode {
  mainFile?: string;
  supportingFiles?: Record<string, unknown>;
  documentation?: string;
}

/**
 * Files that belong at the PROJECT ROOT of the generated server, not under
 * src/. The previous per-component zip builders force-prefixed everything
 * with src/, which nested the Dockerfile at src/Dockerfile - its own
 * `COPY . .` assumes a root build context, so `docker build .` on the
 * extracted zip silently found no Dockerfile at all.
 */
const ROOT_LEVEL_FILES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'Dockerfile',
  '.dockerignore',
  'README.md',
  '.gitignore',
  '.env.example',
]);

function belongsAtRoot(filename: string): boolean {
  return ROOT_LEVEL_FILES.has(filename) || filename.startsWith('.') || !filename.includes('/') && /\.(json|md|yml|yaml)$/.test(filename);
}

/**
 * Build the downloadable zip for a generated MCP server. Single source of
 * truth shared by the chat page and the My Servers page.
 */
export async function buildServerZip(generatedCode: GeneratedServerCode): Promise<Blob> {
  const zip = new JSZip();
  const files = generatedCode.supportingFiles || {};
  const mainFile = generatedCode.mainFile || '';
  const documentation = generatedCode.documentation || '';

  if (mainFile) {
    zip.file('src/index.ts', mainFile);
  }

  for (const [filename, content] of Object.entries(files)) {
    if (typeof content !== 'string') {
      continue;
    }
    let filePath: string;
    if (filename.startsWith('src/') || filename.includes('/')) {
      filePath = filename; // already carries an explicit path
    } else if (belongsAtRoot(filename)) {
      filePath = filename; // Dockerfile, package.json, configs stay at root
    } else {
      filePath = `src/${filename}`; // bare source files default into src/
    }
    zip.file(filePath, content);
  }

  if (documentation && !files['README.md']) {
    zip.file('README.md', documentation);
  }

  if (!files['package.json']) {
    zip.file(
      'package.json',
      JSON.stringify(
        {
          name: 'mcp-server',
          version: '1.0.0',
          type: 'module',
          main: 'dist/index.js',
          scripts: { build: 'tsc', start: 'node dist/index.js' },
          dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
          devDependencies: { typescript: '^5.0.0', '@types/node': '^20.0.0' },
        },
        null,
        2,
      ),
    );
  }

  return zip.generateAsync({ type: 'blob' });
}

/** Build the zip and trigger a browser download of it. */
export async function downloadServerZip(
  generatedCode: GeneratedServerCode,
  filename = 'mcp-server.zip',
): Promise<void> {
  const content = await buildServerZip(generatedCode);
  const url = URL.createObjectURL(content);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
