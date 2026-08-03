import type { PipelineState } from './types';

export type GeneratedCode = NonNullable<PipelineState['generatedCode']>;

/**
 * The on-disk (and in-archive) layout of a generated MCP server.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE, PURE FUNCTION
 * ---------------------------------------------------------------------------
 * `generatedCode` is a bag of named blobs - `mainFile`, `packageJson`,
 * `tsConfig`, `supportingFiles` - and turning it into a real project tree
 * requires knowing that `mainFile` goes to `src/index.ts` and not, say,
 * `index.ts`. That mapping now has two consumers:
 *
 *   1. `GenerationPipeline.writeGeneratedFilesToDisk()` - writes the tree to
 *      `GENERATED_SERVERS_DIR` so the local build/deploy path can read it.
 *   2. `HostedServerSourceService` - streams the same tree as a tarball to a
 *      hosted server's pod, which cannot see another pod's `emptyDir`.
 *
 * If those two disagreed, a server would build locally and fail in the
 * cluster (or vice versa) for reasons invisible in either file. One function,
 * imported by both, makes that class of bug impossible.
 *
 * Deliberately pure and DI-free so it can live in the dependency graph of both
 * `ChatModule` and `HostingModule` without coupling them to each other.
 * ---------------------------------------------------------------------------
 *
 * NOTE ON `tests` / `documentation`: `generatedCode` declares both, and
 * neither has ever been materialised to disk - the generator puts anything it
 * actually wants on disk (Dockerfile, .dockerignore, extra sources) into
 * `supportingFiles`. That behaviour is preserved here rather than
 * "fixed": inventing a path for `tests` now would change what gets built,
 * which is not this change's job.
 */
export function buildGeneratedFileMap(
  generatedCode: PipelineState['generatedCode'] | null | undefined,
): Map<string, string> {
  const files = new Map<string, string>();

  if (!generatedCode) {
    return files;
  }

  if (generatedCode.mainFile) {
    files.set('src/index.ts', generatedCode.mainFile);
  }

  if (generatedCode.packageJson) {
    files.set('package.json', generatedCode.packageJson);
  }

  if (generatedCode.tsConfig) {
    files.set('tsconfig.json', generatedCode.tsConfig);
  }

  // Last so a supporting file may deliberately override one of the three
  // well-known paths above - which is exactly how the generator emits, for
  // example, a hand-tuned `package.json` alongside the default one.
  for (const [path, content] of Object.entries(generatedCode.supportingFiles ?? {})) {
    if (typeof content === 'string') {
      files.set(normalizeRelativePath(path), content);
    }
  }

  return files;
}

/**
 * Strip a leading `./` or `/` so every entry is unambiguously relative to the
 * project root.
 *
 * This does NOT attempt to make a hostile path safe - `..` segments are
 * rejected outright by `SourceArchiveService`, which is the boundary that
 * actually matters (it is what writes an archive a third party extracts).
 * Doing it there rather than here keeps this function a pure description of
 * the layout, with no opinion on trust.
 */
function normalizeRelativePath(path: string): string {
  return path.replace(/^\.?\//, '');
}
