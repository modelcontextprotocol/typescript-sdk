import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { mcpServerApiTransform } from '../../../src/migrations/v1-to-v2/transforms/mcpServerApi.js';
import type { TransformContext } from '../../../src/types.js';

const ctx: TransformContext = { projectType: 'server' };
const MCP_IMPORT = `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n`;

function applyTransform(code: string): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + code);
    mcpServerApiTransform.apply(sourceFile, ctx);
    return sourceFile.getFullText();
}

describe('mcp-server-api transform', () => {
    it('converts .tool(name, callback) to .registerTool(name, {}, callback)', () => {
        const input = [`server.tool('ping', async () => {`, `    return { content: [{ type: 'text', text: 'pong' }] };`, `});`, ''].join(
            '\n'
        );
        const result = applyTransform(input);
        expect(result).toContain('registerTool');
        expect(result).toContain("'ping'");
        expect(result).toContain('{}');
    });

    it('converts .tool(name, schema, callback) wrapping raw shape', () => {
        const input = [
            `server.tool('greet', { name: z.string() }, async ({ name }) => {`,
            `    return { content: [{ type: 'text', text: name }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerTool');
        expect(result).toContain('inputSchema: z.object({ name: z.string() })');
    });

    it('converts .tool(name, description, schema, callback)', () => {
        const input = [
            `server.tool('greet', 'Greet user', { name: z.string() }, async ({ name }) => {`,
            `    return { content: [{ type: 'text', text: name }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerTool');
        expect(result).toContain("description: 'Greet user'");
        expect(result).toContain('inputSchema: z.object({ name: z.string() })');
    });

    it('converts .prompt(name, schema, callback)', () => {
        const input = [
            `server.prompt('summarize', { text: z.string() }, async ({ text }) => {`,
            `    return { messages: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerPrompt');
        expect(result).toContain('argsSchema: z.object({ text: z.string() })');
    });

    it('converts .resource(name, uri, callback) inserting empty metadata', () => {
        const input = [
            `server.resource('config', 'config://app', async (uri) => {`,
            `    return { contents: [{ uri: uri.href, text: '{}' }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerResource');
        expect(result).toContain('{}');
    });

    it('applies transform when McpServer is aliased', () => {
        const input = [
            `import { McpServer as Server } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const server = new Server({ name: 'test', version: '1.0' });`,
            `server.tool('ping', async () => {`,
            `    return { content: [{ type: 'text', text: 'pong' }] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(result.changesCount).toBeGreaterThan(0);
        expect(sourceFile.getFullText()).toContain('registerTool');
    });

    it('does not modify .tool() calls in files without MCP imports', () => {
        const input = [`import { someLib } from 'other-package';`, `someLib.tool('test', async () => {});`, ''].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(result.changesCount).toBe(0);
        expect(sourceFile.getFullText()).toContain("someLib.tool('test'");
        expect(sourceFile.getFullText()).not.toContain('registerTool');
    });

    it('does not wrap z.object() schemas', () => {
        const input = [
            `server.tool('greet', z.object({ name: z.string() }), async ({ name }) => {`,
            `    return { content: [{ type: 'text', text: name }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('inputSchema: z.object({ name: z.string() })');
        expect(result).not.toContain('z.object(z.object(');
    });

    it('emits warning for .resource() with 5+ arguments', () => {
        const input = [`server.resource('name', 'uri://x', metadata, callback, extraArg);`, ''].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('Could not automatically migrate .resource()');
        // Verify the method name was NOT mutated when migration fails
        expect(sourceFile.getFullText()).toContain('.resource(');
        expect(sourceFile.getFullText()).not.toContain('registerResource');
    });
});
