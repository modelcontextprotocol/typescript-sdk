import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { specSchemaAccessTransform } from '../../../src/migrations/v1-to-v2/transforms/specSchemaAccess.js';
import type { TransformContext } from '../../../src/types.js';

const ctx: TransformContext = { projectType: 'server' };

function applyTransform(code: string) {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    const result = specSchemaAccessTransform.apply(sourceFile, ctx);
    return { text: sourceFile.getFullText(), result };
}

describe('spec-schema-access transform', () => {
    describe('auto-transform: .safeParse(v).success → isSpecType.X(v)', () => {
        it('rewrites XSchema.safeParse(v).success to isSpecType.X(v)', () => {
            const input = [
                `import { CallToolRequestSchema } from '@modelcontextprotocol/server';`,
                `const valid = CallToolRequestSchema.safeParse(data).success;`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('isSpecType.CallToolRequest(data)');
            expect(text).not.toContain('safeParse');
            expect(result.changesCount).toBeGreaterThan(0);
        });

        it('handles safeParse().success in if-condition', () => {
            const input = [
                `import { ToolSchema } from '@modelcontextprotocol/server';`,
                `if (ToolSchema.safeParse(obj).success) { doSomething(); }`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('isSpecType.Tool(obj)');
            expect(text).not.toContain('safeParse');
        });

        it('adds isSpecType import when transforming safeParse().success', () => {
            const input = [
                `import { CallToolResultSchema } from '@modelcontextprotocol/server';`,
                `const ok = CallToolResultSchema.safeParse(x).success;`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('isSpecType');
            expect(text).toMatch(/import.*isSpecType.*from/);
        });
    });

    describe('auto-transform: value position → specTypeSchemas.X', () => {
        it('replaces schema passed as function arg with specTypeSchemas.X', () => {
            const input = [
                `import { ListToolsRequestSchema } from '@modelcontextprotocol/server';`,
                `validate(ListToolsRequestSchema);`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.ListToolsRequest');
            expect(result.changesCount).toBeGreaterThan(0);
            expect(result.diagnostics.length).toBeGreaterThan(0);
            expect(result.diagnostics[0]!.message).toContain('StandardSchemaV1');
        });

        it('adds specTypeSchemas import', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `const s = ToolSchema;`, ''].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.Tool');
            expect(text).toMatch(/import.*specTypeSchemas.*from/);
        });
    });

    describe('auto-transform: captured safeParse result', () => {
        it('rewrites captured safeParse call and result property accesses', () => {
            const input = [
                `import { CallToolResultSchema } from '@modelcontextprotocol/server';`,
                `const parsed = CallToolResultSchema.safeParse(data);`,
                `if (parsed.success) { return parsed.data; }`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain("specTypeSchemas.CallToolResult['~standard'].validate(data)");
            expect(text).toContain('parsed.issues === undefined');
            expect(text).toContain('parsed.value');
            expect(text).not.toContain('safeParse');
            expect(text).not.toContain('parsed.success');
            expect(text).not.toContain('parsed.data');
            expect(result.changesCount).toBeGreaterThan(0);
        });

        it('rewrites .error to .issues', () => {
            const input = [
                `import { ToolSchema } from '@modelcontextprotocol/server';`,
                `const result = ToolSchema.safeParse(raw);`,
                `if (!result.success) { console.log(result.error); }`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('result.issues');
            expect(text).not.toContain('result.error');
        });

        it('handles ternary pattern: x.success ? x.data : fallback', () => {
            const input = [
                `import { CallToolResultSchema } from '@modelcontextprotocol/server';`,
                `const parsed = CallToolResultSchema.safeParse(toolResult);`,
                `return parsed.success ? parsed.data : undefined;`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain("specTypeSchemas.CallToolResult['~standard'].validate(toolResult)");
            expect(text).toContain('(parsed.issues === undefined) ? parsed.value : undefined');
        });

        it('adds specTypeSchemas import', () => {
            const input = [
                `import { ToolSchema } from '@modelcontextprotocol/server';`,
                `const r = ToolSchema.safeParse(v);`,
                `r.success;`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toMatch(/import.*specTypeSchemas.*from/);
        });

        it('falls back to diagnostic for non-captured safeParse (bare expression)', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `ToolSchema.safeParse(data);`, ''].join('\n');
            const { result } = applyTransform(input);
            expect(result.changesCount).toBe(0);
            expect(result.diagnostics.length).toBe(1);
        });
    });

    describe('guardrails: non-MCP schemas are NOT touched', () => {
        it('does not rewrite safeParse on user-defined schema with same name from local import', () => {
            const input = [
                `import { CallToolResultSchema } from './mySchemas';`,
                `const parsed = CallToolResultSchema.safeParse(data);`,
                `if (parsed.success) { return parsed.data; }`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('CallToolResultSchema.safeParse');
            expect(text).toContain('parsed.success');
            expect(text).toContain('parsed.data');
            expect(result.changesCount).toBe(0);
            expect(result.diagnostics.length).toBe(0);
        });

        it('does not rewrite safeParse on user zod schema not from MCP', () => {
            const input = [
                `import { z } from 'zod';`,
                `const MySchema = z.object({ name: z.string() });`,
                `const parsed = MySchema.safeParse(data);`,
                `if (parsed.success) { return parsed.data; }`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('MySchema.safeParse');
            expect(text).toContain('parsed.success');
            expect(text).toContain('parsed.data');
            expect(result.changesCount).toBe(0);
            expect(result.diagnostics.length).toBe(0);
        });

        it('does not rewrite safeParse on non-spec schema name from MCP import', () => {
            const input = [
                `import { SomeRandomSchema } from '@modelcontextprotocol/server';`,
                `const parsed = SomeRandomSchema.safeParse(data);`,
                `if (parsed.success) { return parsed.data; }`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('SomeRandomSchema.safeParse');
            expect(text).toContain('parsed.success');
            expect(result.changesCount).toBe(0);
            expect(result.diagnostics.length).toBe(0);
        });

        it('does not rewrite safeParse on npm package schema with matching name', () => {
            const input = [
                `import { CallToolResultSchema } from 'some-other-package';`,
                `const parsed = CallToolResultSchema.safeParse(data);`,
                `if (parsed.success) { return parsed.data; }`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('CallToolResultSchema.safeParse');
            expect(text).toContain('parsed.success');
            expect(result.changesCount).toBe(0);
            expect(result.diagnostics.length).toBe(0);
        });
    });

    describe('diagnostic only: .parse(v)', () => {
        it('emits diagnostic for parse usage', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `const tool = ToolSchema.parse(raw);`, ''].join(
                '\n'
            );
            const { text, result } = applyTransform(input);
            expect(text).toContain('ToolSchema.parse');
            expect(result.changesCount).toBe(0);
            expect(result.diagnostics.length).toBe(1);
            expect(result.diagnostics[0]!.message).toContain('isSpecType.Tool');
        });
    });

    describe('diagnostic: z.infer<typeof XSchema>', () => {
        it('emits diagnostic for typeof in type position', () => {
            const input = [
                `import { CallToolResultSchema } from '@modelcontextprotocol/client';`,
                `type Result = typeof CallToolResultSchema;`,
                ''
            ].join('\n');
            const { result } = applyTransform(input);
            expect(result.diagnostics.length).toBe(1);
            expect(result.diagnostics[0]!.message).toContain('CallToolResult');
        });
    });

    describe('no-op cases', () => {
        it('does nothing for non-MCP imports', () => {
            const input = [`import { CallToolRequestSchema } from './local';`, `CallToolRequestSchema.safeParse(data);`, ''].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('CallToolRequestSchema.safeParse');
            expect(result.changesCount).toBe(0);
            expect(result.diagnostics.length).toBe(0);
        });

        it('does nothing for non-spec schema names', () => {
            const input = [`import { SomeRandomSchema } from '@modelcontextprotocol/server';`, `SomeRandomSchema.parse(data);`, ''].join(
                '\n'
            );
            const { text, result } = applyTransform(input);
            expect(text).toContain('SomeRandomSchema.parse');
            expect(result.changesCount).toBe(0);
            expect(result.diagnostics.length).toBe(0);
        });

        it('does nothing when no remaining references', () => {
            const input = [`import { CallToolRequestSchema } from '@modelcontextprotocol/server';`, ''].join('\n');
            const { result } = applyTransform(input);
            expect(result.changesCount).toBe(0);
            expect(result.diagnostics.length).toBe(0);
        });
    });

    describe('import cleanup after transform', () => {
        it('removes original schema import after all refs are auto-transformed', () => {
            const input = [
                `import { CallToolRequestSchema } from '@modelcontextprotocol/server';`,
                `const valid = CallToolRequestSchema.safeParse(data).success;`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('isSpecType.CallToolRequest(data)');
            expect(text).not.toMatch(/import\s*\{[^}]*CallToolRequestSchema[^}]*\}/);
        });

        it('keeps original schema import when some refs are diagnostic-only', () => {
            const input = [
                `import { CallToolRequestSchema } from '@modelcontextprotocol/server';`,
                `const valid = CallToolRequestSchema.safeParse(data).success;`,
                `const parsed = CallToolRequestSchema.parse(data);`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('isSpecType.CallToolRequest(data)');
            expect(text).toContain('CallToolRequestSchema.parse');
            expect(text).toMatch(/import\s*\{[^}]*CallToolRequestSchema[^}]*\}/);
        });

        it('removes schema specifier from import that also has other symbols', () => {
            const input = [
                `import { CallToolRequestSchema, McpError } from '@modelcontextprotocol/server';`,
                `const valid = CallToolRequestSchema.safeParse(data).success;`,
                `throw new McpError(1, 'fail');`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).not.toMatch(/import\s*\{[^}]*CallToolRequestSchema[^}]*\}/);
            expect(text).toContain('McpError');
            expect(text).toContain(`@modelcontextprotocol/server`);
        });
    });

    describe('parent-kind guards', () => {
        it('emits diagnostic for re-exported schema (ExportSpecifier)', () => {
            const input = [
                `import { CallToolRequestSchema } from '@modelcontextprotocol/server';`,
                `export { CallToolRequestSchema };`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('export { CallToolRequestSchema }');
            expect(result.diagnostics.some(d => d.message.includes('Re-export'))).toBe(true);
            expect(result.changesCount).toBe(0);
        });

        it('expands shorthand property assignment and removes import', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `const schemas = { ToolSchema };`, ''].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain("'ToolSchema': specTypeSchemas.Tool");
            expect(text).not.toMatch(/import\s*\{[^}]*ToolSchema[^}]*\}/);
            expect(result.changesCount).toBeGreaterThan(0);
        });

        it('skips PropertyAssignment name-node (non-shorthand)', () => {
            const input = [
                `import { ToolSchema } from '@modelcontextprotocol/server';`,
                `const schemas = { ToolSchema: myValidator };`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('ToolSchema: myValidator');
            expect(result.changesCount).toBe(0);
        });

        it('skips BindingElement property-name', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `const { ToolSchema: local } = obj;`, ''].join(
                '\n'
            );
            const { text, result } = applyTransform(input);
            expect(text).toContain('ToolSchema: local');
            expect(result.changesCount).toBe(0);
        });
    });

    describe('aliased imports', () => {
        it('handles aliased import and auto-transforms captured safeParse', () => {
            const input = [
                `import { CallToolRequestSchema as CTRS } from '@modelcontextprotocol/server';`,
                `const result = CTRS.safeParse(data);`,
                `result.success;`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain("specTypeSchemas.CallToolRequest['~standard'].validate(data)");
            expect(text).not.toContain('CTRS.safeParse');
            expect(result.changesCount).toBeGreaterThan(0);
            expect(result.diagnostics[0]!.message).toContain('specTypeSchemas.CallToolRequest');
        });
    });
});
