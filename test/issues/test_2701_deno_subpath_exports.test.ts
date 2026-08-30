import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type ExportEntry = {
    types: string;
    import: string;
    require: string;
};

describe('Issue #2701: Deno resolves .js subpaths to declarations without .js', () => {
    test('provides an explicit .js export pattern for type resolution', () => {
        const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../package.json'), 'utf8')) as {
            exports: Record<string, ExportEntry>;
        };
        const jsSubpath = packageJson.exports['./*.js'];

        expect(jsSubpath).toEqual({
            types: './dist/esm/*.d.ts',
            import: './dist/esm/*.js',
            require: './dist/cjs/*.js'
        });
    });
});
