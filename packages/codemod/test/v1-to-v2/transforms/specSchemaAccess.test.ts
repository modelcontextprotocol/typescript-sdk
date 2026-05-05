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

    describe('diagnostic only: .safeParse(v) result captured', () => {
        it('emits diagnostic for captured safeParse result', () => {
            const input = [
                `import { CallToolRequestSchema } from '@modelcontextprotocol/server';`,
                `const result = CallToolRequestSchema.safeParse(data);`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('CallToolRequestSchema.safeParse');
            expect(result.changesCount).toBe(0);
            expect(result.diagnostics.length).toBe(1);
            expect(result.diagnostics[0]!.message).toContain('isSpecType.CallToolRequest');
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

    describe('aliased imports', () => {
        it('handles aliased import and references original name in diagnostic', () => {
            const input = [
                `import { CallToolRequestSchema as CTRS } from '@modelcontextprotocol/server';`,
                `const result = CTRS.safeParse(data);`,
                ''
            ].join('\n');
            const { result } = applyTransform(input);
            expect(result.diagnostics.length).toBe(1);
            expect(result.diagnostics[0]!.message).toContain('isSpecType.CallToolRequest');
        });
    });
});
