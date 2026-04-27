import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { removedApisTransform } from '../../../src/migrations/v1-to-v2/transforms/removedApis.js';
import type { TransformContext } from '../../../src/types.js';
import { DiagnosticLevel } from '../../../src/types.js';

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

    describe('StreamableHTTPError → SdkError', () => {
        it('renames StreamableHTTPError to SdkError in references', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `if (error instanceof StreamableHTTPError) { throw error; }`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('instanceof SdkError');
            expect(text).not.toContain('StreamableHTTPError');
        });

        it('adds SdkError import without SdkErrorCode when no constructor calls', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `if (error instanceof StreamableHTTPError) {}`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('SdkError');
            expect(text).not.toContain('SdkErrorCode');
        });

        it('adds SdkError and SdkErrorCode imports when constructor calls exist', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `throw new StreamableHTTPError(404, 'Not Found');`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('SdkError');
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

        it('emits general migration warning', () => {
            const input = [
                `import { StreamableHTTPError } from '@modelcontextprotocol/client';`,
                `if (error instanceof StreamableHTTPError) {}`,
                ''
            ].join('\n');
            const { result } = applyTransform(input);
            const migrationWarning = result.diagnostics.find(d => d.message.includes('error.data?.status'));
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
            expect(text).toMatch(/import.*SdkError/);
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
            expect(text).toContain('instanceof SdkError');
            expect(text).not.toMatch(/\bSHE\b/);
            expect(text).toMatch(/import.*SdkError/);
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
