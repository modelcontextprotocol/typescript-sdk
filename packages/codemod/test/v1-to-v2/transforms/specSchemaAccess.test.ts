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
    // The v2 specTypeSchemas entries expose Zod-compatible .parse()/.safeParse(), so every spec
    // schema reference — including .parse()/.safeParse() calls — is migrated by the same rename:
    // `XSchema` → `specTypeSchemas.X`, leaving the call and any result-property access untouched.
    describe('rename: .safeParse(v) and its result are preserved', () => {
        it('renames XSchema.safeParse(v).success to specTypeSchemas.X.safeParse(v).success', () => {
            const input = [
                `import { CallToolRequestSchema } from '@modelcontextprotocol/server';`,
                `const valid = CallToolRequestSchema.safeParse(data).success;`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.CallToolRequest.safeParse(data).success');
            expect(text).not.toContain('isSpecType');
            expect(result.changesCount).toBeGreaterThan(0);
        });

        it('handles safeParse().success in if-condition', () => {
            const input = [
                `import { ToolSchema } from '@modelcontextprotocol/server';`,
                `if (ToolSchema.safeParse(obj).success) { doSomething(); }`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.Tool.safeParse(obj).success');
        });

        it('adds specTypeSchemas import when transforming safeParse().success', () => {
            const input = [
                `import { CallToolResultSchema } from '@modelcontextprotocol/server';`,
                `const ok = CallToolResultSchema.safeParse(x).success;`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('specTypeSchemas');
            expect(text).toMatch(/import.*specTypeSchemas.*from/);
        });

        it('preserves captured safeParse result properties (.success/.data/.error) unchanged', () => {
            const input = [
                `import { CallToolResultSchema } from '@modelcontextprotocol/server';`,
                `const parsed = CallToolResultSchema.safeParse(data);`,
                `if (parsed.success) { return parsed.data; }`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.CallToolResult.safeParse(data)');
            expect(text).toContain('parsed.success');
            expect(text).toContain('parsed.data');
            // No Standard Schema remapping is performed — the Zod-shaped result is retained.
            expect(text).not.toContain("['~standard']");
            expect(text).not.toContain('parsed.issues');
            expect(result.changesCount).toBeGreaterThan(0);
        });

        it('preserves .error access (Zod error shape is retained)', () => {
            const input = [
                `import { ToolSchema } from '@modelcontextprotocol/server';`,
                `const result = ToolSchema.safeParse(raw);`,
                `if (!result.success) { console.log(result.error.issues); }`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.Tool.safeParse(raw)');
            expect(text).toContain('result.error.issues');
            expect(text).not.toContain("['~standard']");
        });

        it('preserves ternary pattern: x.success ? x.data : fallback', () => {
            const input = [
                `import { CallToolResultSchema } from '@modelcontextprotocol/server';`,
                `const parsed = CallToolResultSchema.safeParse(toolResult);`,
                `return parsed.success ? parsed.data : undefined;`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.CallToolResult.safeParse(toolResult)');
            expect(text).toContain('parsed.success ? parsed.data : undefined');
        });

        it('renames bare (non-captured) safeParse expression', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `ToolSchema.safeParse(data);`, ''].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.Tool.safeParse(data)');
            expect(result.changesCount).toBe(1);
        });

        it('does not rewrite a same-named result variable in a sibling function', () => {
            const input = [
                `import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
                `function validate(d: unknown) {`,
                `    const result = CallToolRequestSchema.safeParse(d);`,
                `    return result.success;`,
                `}`,
                `async function callApi(client: any) {`,
                `    const result = await client.get('/api');`,
                `    return result.data;`,
                `}`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.CallToolRequest.safeParse(d)');
            expect(text).toContain('return result.success');
            expect(text).toContain('return result.data');
        });
    });

    describe('rename: .parse(v) is preserved', () => {
        it('renames XSchema.parse(v) to specTypeSchemas.X.parse(v)', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `const tool = ToolSchema.parse(raw);`, ''].join(
                '\n'
            );
            const { text, result } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.Tool.parse(raw)');
            expect(text).not.toMatch(/import\s*\{[^}]*ToolSchema[^}]*\}/);
            expect(result.changesCount).toBe(1);
        });

        it('emits an info diagnostic (not action-required) for the parse rename', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `const tool = ToolSchema.parse(raw);`, ''].join(
                '\n'
            );
            const { result } = applyTransform(input);
            expect(result.diagnostics).toHaveLength(1);
            expect(result.diagnostics[0]!.level).toBe('info');
            expect(result.diagnostics[0]!.message).toContain('specTypeSchemas.Tool');
        });
    });

    describe('rename: value position → specTypeSchemas.X', () => {
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
            expect(result.diagnostics[0]!.message).toContain('specTypeSchemas.ListToolsRequest');
        });

        it('adds specTypeSchemas import', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `const s = ToolSchema;`, ''].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.Tool');
            expect(text).toMatch(/import.*specTypeSchemas.*from/);
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

    describe('rename: other Zod methods are renamed but flagged (not exposed in v2)', () => {
        it('replaces schema identifier in .parseAsync() call', () => {
            const input = [
                `import { OAuthTokensSchema } from '@modelcontextprotocol/server';`,
                `const tokens = await OAuthTokensSchema.parseAsync(data);`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.OAuthTokens.parseAsync(data)');
            expect(text).not.toMatch(/import\s*\{[^}]*OAuthTokensSchema[^}]*\}/);
            expect(result.changesCount).toBeGreaterThan(0);
            // .parseAsync is not exposed on the v2 entry → warns to migrate manually.
            expect(result.diagnostics.some(d => d.level === 'warning' && d.message.includes('parseAsync'))).toBe(true);
        });

        it('replaces schema identifier in .or() call', () => {
            const input = [
                `import { ServerNotificationSchema } from '@modelcontextprotocol/server';`,
                `const union = ServerNotificationSchema.or(otherSchema);`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.ServerNotification.or(otherSchema)');
            expect(text).not.toMatch(/import\s*\{[^}]*ServerNotificationSchema[^}]*\}/);
            expect(result.changesCount).toBeGreaterThan(0);
        });

        it('replaces schema identifier in .extend() call', () => {
            const input = [
                `import { ToolSchema } from '@modelcontextprotocol/server';`,
                `const extended = ToolSchema.extend({ extra: z.string() });`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.Tool.extend');
            expect(result.changesCount).toBeGreaterThan(0);
        });

        it('adds specTypeSchemas import for generic property access', () => {
            const input = [
                `import { OAuthTokensSchema } from '@modelcontextprotocol/server';`,
                `const tokens = await OAuthTokensSchema.parseAsync(data);`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toMatch(/import.*specTypeSchemas.*from/);
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
        it('removes original schema import after all refs are renamed', () => {
            const input = [
                `import { CallToolRequestSchema } from '@modelcontextprotocol/server';`,
                `const valid = CallToolRequestSchema.safeParse(data).success;`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.CallToolRequest.safeParse(data)');
            expect(text).not.toMatch(/import\s*\{[^}]*CallToolRequestSchema[^}]*\}/);
        });

        it('removes original schema import when refs mix safeParse and parse', () => {
            const input = [
                `import { CallToolRequestSchema } from '@modelcontextprotocol/server';`,
                `const valid = CallToolRequestSchema.safeParse(data).success;`,
                `const parsed = CallToolRequestSchema.parse(data);`,
                ''
            ].join('\n');
            const { text } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.CallToolRequest.safeParse(data)');
            expect(text).toContain('specTypeSchemas.CallToolRequest.parse(data)');
            expect(text).not.toMatch(/import\s*\{[^}]*CallToolRequestSchema[^}]*\}/);
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

        it('skips PropertyAccessExpression name-node (obj.ToolSchema)', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `const x = registry.ToolSchema;`, ''].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('registry.ToolSchema');
            expect(text).not.toContain('specTypeSchemas');
            expect(result.changesCount).toBe(0);
        });

        it('does not emit z.infer diagnostic for runtime typeof (TypeOfExpression)', () => {
            const input = [`import { ToolSchema } from '@modelcontextprotocol/server';`, `const kind = typeof ToolSchema;`, ''].join('\n');
            const { result } = applyTransform(input);
            expect(result.diagnostics.every(d => !d.message.includes('z.infer'))).toBe(true);
        });
    });

    describe('namespace imports', () => {
        it('does not crash when file has namespace import from same package', () => {
            const input = [
                `import * as types from '@modelcontextprotocol/server';`,
                `import { ToolSchema } from '@modelcontextprotocol/server';`,
                `const s = ToolSchema;`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.Tool');
            expect(result.changesCount).toBeGreaterThan(0);
        });
    });

    describe('aliased imports', () => {
        it('handles aliased import and renames captured safeParse', () => {
            const input = [
                `import { CallToolRequestSchema as CTRS } from '@modelcontextprotocol/server';`,
                `const result = CTRS.safeParse(data);`,
                `result.success;`,
                ''
            ].join('\n');
            const { text, result } = applyTransform(input);
            expect(text).toContain('specTypeSchemas.CallToolRequest.safeParse(data)');
            expect(text).toContain('result.success');
            expect(text).not.toContain('CTRS.safeParse');
            expect(result.changesCount).toBeGreaterThan(0);
            expect(result.diagnostics[0]!.message).toContain('specTypeSchemas.CallToolRequest');
        });
    });
});
