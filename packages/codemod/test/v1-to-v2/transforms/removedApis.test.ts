import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { removedApisTransform } from '../../../src/migrations/v1-to-v2/transforms/removedApis';
import type { TransformContext } from '../../../src/types';
import { DiagnosticLevel } from '../../../src/types';

const ctx: TransformContext = { projectType: 'server' };

function applyTransform(code: string, context: TransformContext = ctx) {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    const result = removedApisTransform.apply(sourceFile, context);
    return { text: sourceFile.getFullText(), result };
}

describe('removed-apis transform', () => {
    describe('removed Zod helpers', () => {
        it('removes schemaToJson import and emits warning', () => {
            const input = [`import { schemaToJson } from '@modelcontextprotocol/server';`, `const json = schemaToJson(schema);`, ''].join(
                '\n'
            );
            const { text, result } = applyTransform(input);
            expect(text).not.toContain('import { schemaToJson }');
            expect(result.changesCount).toBeGreaterThan(0);
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]!.level).toBe(DiagnosticLevel.Warning);
            expect(result.diagnostics[0]!.message).toContain('schemaToJson');
        });

        it('removes parseSchemaAsync import and emits warning', () => {
            const input = [
                `import { parseSchemaAsync } from '@modelcontextprotocol/server';`,
                `const result = await parseSchemaAsync(schema, data);`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).not.toContain('import { parseSchemaAsync }');
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]!.message).toContain('parseSchemaAsync');
        });

        it('removes getSchemaShape import and emits warning', () => {
            const input = [
                `import { getSchemaShape } from '@modelcontextprotocol/server';`,
                `const shape = getSchemaShape(schema);`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).not.toContain('import { getSchemaShape }');
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]!.message).toContain('getSchemaShape');
        });

        it('removes multiple zod helpers from same import declaration', () => {
            const input = [`import { schemaToJson, parseSchemaAsync, getSchemaShape } from '@modelcontextprotocol/server';`, ''].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).not.toContain('schemaToJson');
            expect(text).not.toContain('parseSchemaAsync');
            expect(text).not.toContain('getSchemaShape');
            expect(text).not.toContain("from '@modelcontextprotocol/server'");
            expect(result.changesCount).toBe(3);
            expect(result.diagnostics).toHaveLength(3);
        });

        it('preserves non-removed symbols in same import', () => {
            const input = [
                `import { McpServer, schemaToJson } from '@modelcontextprotocol/server';`,
                `const server = new McpServer({ name: 'test', version: '1.0' });`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain("import { McpServer } from '@modelcontextprotocol/server'");
            expect(text).not.toContain('schemaToJson');
            expect(result.changesCount).toBe(1);
        });

        it('does not touch non-MCP imports with same names', () => {
            const input = [`import { schemaToJson } from 'some-other-lib';`, `const json = schemaToJson(schema);`, ''].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain("import { schemaToJson } from 'some-other-lib'");
            expect(result.changesCount).toBe(0);
        });

        it('does not remove same-named import from non-MCP package when MCP import is also present', () => {
            const input = [
                `import { McpServer, schemaToJson } from '@modelcontextprotocol/server';`,
                `import { schemaToJson as otherToJson } from 'some-json-schema-lib';`,
                `const json = otherToJson(schema);`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain("import { schemaToJson as otherToJson } from 'some-json-schema-lib'");
            expect(text).toContain('otherToJson(schema)');
        });

        it('is idempotent', () => {
            const input = [`import { schemaToJson } from '@modelcontextprotocol/server';`, `const json = schemaToJson(schema);`, ''].join(
                '\n'
            );
            const { text: first } = applyTransform(input);
            const { text: second } = applyTransform(first);
            expect(second).toBe(first);
        });
    });

    describe('IsomorphicHeaders removal', () => {
        it('replaces IsomorphicHeaders with Headers in type annotations', () => {
            const input = [
                `import { IsomorphicHeaders } from '@modelcontextprotocol/server';`,
                `const headers: IsomorphicHeaders = new Headers();`,
                `function getHeaders(): IsomorphicHeaders { return new Headers(); }`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('const headers: Headers');
            expect(text).toContain('function getHeaders(): Headers');
            expect(text).not.toContain('IsomorphicHeaders');
        });

        it('removes IsomorphicHeaders import entirely', () => {
            const input = [
                `import { IsomorphicHeaders } from '@modelcontextprotocol/server';`,
                `const h: IsomorphicHeaders = {};`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).not.toContain("from '@modelcontextprotocol/server'");
        });

        it('preserves other imports when removing IsomorphicHeaders', () => {
            const input = [
                `import { McpServer, IsomorphicHeaders } from '@modelcontextprotocol/server';`,
                `const h: IsomorphicHeaders = {};`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain("import { McpServer } from '@modelcontextprotocol/server'");
            expect(text).not.toContain('IsomorphicHeaders');
        });

        it('emits warning about Headers API differences', () => {
            const input = [
                `import { IsomorphicHeaders } from '@modelcontextprotocol/server';`,
                `const h: IsomorphicHeaders = {};`,
                ''
            ].join('\n');
            const { result } = applyTransform(input);
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]!.level).toBe(DiagnosticLevel.Warning);
            expect(result.diagnostics[0]!.message).toContain('Headers');
        });

        it('is idempotent', () => {
            const input = [
                `import { IsomorphicHeaders } from '@modelcontextprotocol/server';`,
                `const h: IsomorphicHeaders = {};`,
                ''
            ].join('\n');
            const { text: first } = applyTransform(input);
            const { text: second } = applyTransform(first);
            expect(second).toBe(first);
        });
    });

    describe('StreamableHTTPError → SdkHttpError', () => {
        it('renames StreamableHTTPError to SdkHttpError in references', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `if (error instanceof StreamableHTTPError) { throw error; }`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('instanceof SdkHttpError');
            expect(text).not.toContain('StreamableHTTPError');
        });

        it('adds SdkHttpError import without SdkErrorCode when no constructor calls', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `if (error instanceof StreamableHTTPError) {}`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('SdkHttpError');
            expect(text).not.toContain('SdkErrorCode');
        });

        it('adds SdkHttpError and SdkErrorCode imports when constructor calls exist', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `throw new StreamableHTTPError(404, 'Not Found');`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('SdkHttpError');
            expect(text).toContain('SdkErrorCode');
        });

        it('emits warning for constructor calls', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `throw new StreamableHTTPError(404, 'Not Found');`,
                ''
            ].join('\n');
            const { result } = applyTransform(input);
            const constructorWarning = result.diagnostics.find(d => d.message.includes('Constructor arguments differ'));
            expect(constructorWarning).toBeDefined();
        });

        it('emits general migration warning pointing at the typed status accessor', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `if (error instanceof StreamableHTTPError) {}`,
                ''
            ].join('\n');
            const { result } = applyTransform(input);
            const migrationWarning = result.diagnostics.find(d => d.message.includes('error.status'));
            expect(migrationWarning).toBeDefined();
        });

        it('removes old import and adds new one', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `if (error instanceof StreamableHTTPError) {}`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).not.toContain('import { StreamableHTTPError }');
            expect(text).toMatch(/import.*SdkHttpError/);
        });

        it('is idempotent', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `if (error instanceof StreamableHTTPError) {}`,
                ''
            ].join('\n');
            const { text: first } = applyTransform(input);
            const { text: second } = applyTransform(first);
            expect(second).toBe(first);
        });

        it('handles aliased StreamableHTTPError import', () => {
            const input = [
                `import { StreamableHTTPError as SHE } from '@modelcontextprotocol/client';`,
                `if (error instanceof SHE) {}`,
                `throw new SHE(404, 'Not Found');`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('instanceof SdkHttpError');
            expect(text).not.toMatch(/\bSHE\b/);
            expect(text).toMatch(/import.*SdkHttpError/);
            const constructorWarning = result.diagnostics.find(d => d.message.includes('Constructor arguments differ'));
            expect(constructorWarning).toBeDefined();
        });
    });

    describe('IsomorphicHeaders alias', () => {
        it('handles aliased IsomorphicHeaders import', () => {
            const input = [`import { IsomorphicHeaders as IH } from '@modelcontextprotocol/server';`, `const h: IH = new IH();`, ''].join(
                '\n'
            );
            const { text } = applyTransform(input);
            expect(text).toContain('const h: Headers = new Headers()');
            expect(text).not.toMatch(/\bIH\b/);
        });
    });
});

describe('finishAuth advisory (B2)', () => {
    function applyWithDiagnostics(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        return removedApisTransform.apply(sourceFile, { projectType: 'client' });
    }

    it('notes a single-argument finishAuth call without a marker', () => {
        const code = [`import { Client } from '@modelcontextprotocol/client';`, `await transport.finishAuth(code);`, ''].join('\n');
        const result = applyWithDiagnostics(code);
        const diag = result.diagnostics.find(d => d.message.includes('finishAuth'));
        expect(diag).toBeDefined();
        // A run-log note, not a marker — the 1-arg URLSearchParams form is valid v2.
        expect(diag?.insertComment).toBeUndefined();
        expect(diag?.message).toContain('iss');
    });

    it('leaves a two-argument finishAuth call alone', () => {
        const code = [`import { Client } from '@modelcontextprotocol/client';`, `await transport.finishAuth(code, iss);`, ''].join('\n');
        const result = applyWithDiagnostics(code);
        expect(result.diagnostics.some(d => d.message.includes('finishAuth'))).toBe(false);
    });

    it('ignores finishAuth in files with no MCP imports', () => {
        const result = applyWithDiagnostics(`await other.finishAuth(code);\n`);
        expect(result.diagnostics.some(d => d.message.includes('finishAuth'))).toBe(false);
    });
});

describe('SdkHttpError constructor marker (B2)', () => {
    it('emits an insertComment diagnostic at each constructor site', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';`,
                `throw new StreamableHTTPError(404, 'not found');`,
                ''
            ].join('\n')
        );
        const result = removedApisTransform.apply(sourceFile, { projectType: 'client' });
        const ctorDiag = result.diagnostics.find(d => d.message.includes('Constructor arguments differ'));
        expect(ctorDiag?.insertComment).toBe(true);
    });
});

describe('finishAuth advisory flag', () => {
    it('marks the one-argument finishAuth note advisory-only so re-runs stay quiet', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [`import { Client } from '@modelcontextprotocol/client';`, `await provider.finishAuth(params);`, ''].join('\n')
        );
        const result = removedApisTransform.apply(sourceFile, { projectType: 'client' });
        const note = result.diagnostics.find(d => d.message.includes('finishAuth with one argument'));
        expect(note).toBeDefined();
        expect(note?.advisoryOnly).toBe(true);
    });
});

describe('guarded .code to .status rewrites (B5, #155)', () => {
    function apply(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = removedApisTransform.apply(sourceFile, { projectType: 'client' });
        return { text: sourceFile.getFullText(), result };
    }
    const IMPORT = `import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';\n`;

    it('rewrites .code in the same boolean expression as the instanceof check', () => {
        const { text } = apply(IMPORT + `if (failure instanceof StreamableHTTPError && failure.code === 404) { retry(); }\n`);
        expect(text).toContain('instanceof SdkHttpError && failure.status === 404');
        expect(text).not.toContain('failure.code');
    });

    it('rewrites .code reads inside the guarded then-block', () => {
        const code =
            IMPORT +
            [`if (err instanceof StreamableHTTPError) {`, `    if (err.code >= 500) backoff();`, `    log(err.code);`, `}`, ''].join('\n');
        const { text } = apply(code);
        expect(text).toContain('err.status >= 500');
        expect(text).toContain('log(err.status)');
    });

    it('leaves unguarded .code reads alone', () => {
        const { text } = apply(IMPORT + `classify(error.code);\n`);
        expect(text).toContain('classify(error.code)');
    });

    it('does not rewrite under negated guards', () => {
        const { text } = apply(IMPORT + `if (!(err instanceof StreamableHTTPError)) { classify(err.code); }\n`);
        expect(text).toContain('classify(err.code)');
    });

    it('does not rewrite the other operand of a disjunction', () => {
        const { text } = apply(IMPORT + `const retriable = err instanceof StreamableHTTPError || err.code === 'ECONNRESET';\n`);
        expect(text).toContain(`err.code === 'ECONNRESET'`);
    });

    it('does not rewrite then-blocks reached through a disjunction', () => {
        const { text } = apply(IMPORT + `if (err instanceof StreamableHTTPError || isTimeout(err)) { log(err.code); }\n`);
        expect(text).toContain('log(err.code)');
    });

    it('does not rewrite shadowed same-name variables in the guarded block', () => {
        const code = IMPORT + [`if (err instanceof StreamableHTTPError) {`, `    items.forEach(err => log(err.code));`, `}`, ''].join('\n');
        const { text } = apply(code);
        expect(text).toContain('log(err.code)');
    });

    it('skips the whole then-block when the subject is reassigned inside it', () => {
        const code = IMPORT + [`if (e instanceof StreamableHTTPError) {`, `    e = unwrap(e);`, `    use(e.code);`, `}`, ''].join('\n');
        const { text } = apply(code);
        expect(text).toContain('use(e.code)');
    });

    it('does not touch other subjects in the same expression', () => {
        const { text } = apply(IMPORT + `if (a instanceof StreamableHTTPError && b.code === 404) handle();\n`);
        expect(text).toContain('b.code === 404');
    });
});
