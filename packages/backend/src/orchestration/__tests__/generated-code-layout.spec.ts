import { buildGeneratedFileMap } from '../generated-code-layout';

describe('buildGeneratedFileMap', () => {
  it('returns an empty map for missing generated code', () => {
    expect(buildGeneratedFileMap(undefined).size).toBe(0);
    expect(buildGeneratedFileMap(null).size).toBe(0);
  });

  /**
   * The mapping that matters: `mainFile` is the server entrypoint and must land
   * at `src/index.ts`, because that is what the generated `package.json`'s
   * build script and the generated `Dockerfile` both expect.
   */
  it('places mainFile at src/index.ts', () => {
    const files = buildGeneratedFileMap({
      mainFile: 'console.log(1);',
      supportingFiles: {},
    });

    expect(files.get('src/index.ts')).toBe('console.log(1);');
  });

  it('places packageJson and tsConfig at the project root', () => {
    const files = buildGeneratedFileMap({
      mainFile: 'x',
      packageJson: '{"name":"x"}',
      tsConfig: '{"compilerOptions":{}}',
      supportingFiles: {},
    });

    expect(files.get('package.json')).toBe('{"name":"x"}');
    expect(files.get('tsconfig.json')).toBe('{"compilerOptions":{}}');
  });

  it('omits absent optional blobs rather than writing empty files', () => {
    const files = buildGeneratedFileMap({ mainFile: 'x', supportingFiles: {} });

    expect(files.has('package.json')).toBe(false);
    expect(files.has('tsconfig.json')).toBe(false);
    expect([...files.keys()]).toEqual(['src/index.ts']);
  });

  it('carries supporting files through at their own paths', () => {
    const files = buildGeneratedFileMap({
      mainFile: 'x',
      supportingFiles: {
        Dockerfile: 'FROM node:20-alpine',
        '.dockerignore': 'node_modules',
        'src/tools/get-user.ts': 'export {};',
      },
    });

    expect(files.get('Dockerfile')).toBe('FROM node:20-alpine');
    expect(files.get('.dockerignore')).toBe('node_modules');
    expect(files.get('src/tools/get-user.ts')).toBe('export {};');
  });

  it('normalises a leading ./ or / so every entry is root-relative', () => {
    const files = buildGeneratedFileMap({
      mainFile: 'x',
      supportingFiles: { './a.ts': 'a', '/b.ts': 'b' },
    });

    expect(files.has('a.ts')).toBe(true);
    expect(files.has('b.ts')).toBe(true);
    expect(files.has('./a.ts')).toBe(false);
    expect(files.has('/b.ts')).toBe(false);
  });

  it('lets a supporting file deliberately override a well-known path', () => {
    const files = buildGeneratedFileMap({
      mainFile: 'default',
      packageJson: '{"default":true}',
      supportingFiles: { 'package.json': '{"handTuned":true}' },
    });

    expect(files.get('package.json')).toBe('{"handTuned":true}');
  });

  it('ignores a non-string supporting file value rather than writing "[object Object]"', () => {
    const files = buildGeneratedFileMap({
      mainFile: 'x',
      supportingFiles: { 'bad.json': { nested: true } as unknown as string },
    });

    expect(files.has('bad.json')).toBe(false);
  });

  it('tolerates generatedCode with no supportingFiles key at all', () => {
    const files = buildGeneratedFileMap({
      mainFile: 'x',
    } as unknown as Parameters<typeof buildGeneratedFileMap>[0]);

    expect(files.get('src/index.ts')).toBe('x');
  });
});
