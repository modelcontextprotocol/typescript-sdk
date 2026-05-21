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

    it('converts .tool(name, schema, annotations, callback) when args[1] is not a string', () => {
        const input = [
            `server.tool('greet', { name: z.string() }, { readOnlyHint: true }, async ({ name }) => {`,
            `    return { content: [{ type: 'text', text: name }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerTool');
        expect(result).toContain('inputSchema: z.object({ name: z.string() })');
        expect(result).toContain('annotations: { readOnlyHint: true }');
        expect(result).not.toContain('description');
    });

    it('converts .tool(name, description, schema, annotations, callback) with 5 args', () => {
        const input = [
            `server.tool('greet', 'Greet user', { name: z.string() }, { readOnlyHint: true }, async ({ name }) => {`,
            `    return { content: [{ type: 'text', text: name }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerTool');
        expect(result).toContain("description: 'Greet user'");
        expect(result).toContain('inputSchema: z.object({ name: z.string() })');
        expect(result).toContain('annotations: { readOnlyHint: true }');
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

    it('converts .resource(name, uri, metadata, callback) renaming method only', () => {
        const input = [
            `server.resource('config', 'config://app', { description: 'App config' }, async (uri) => {`,
            `    return { contents: [{ uri: uri.href, text: '{}' }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerResource');
        expect(result).toContain("{ description: 'App config' }");
        expect(result).not.toContain('.resource(');
    });

    it('converts .prompt(name, callback) with empty config', () => {
        const input = [`server.prompt('greet', async () => {`, `    return { messages: [] };`, `});`, ''].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerPrompt');
        expect(result).toContain('{}');
        expect(result).not.toContain('.prompt(');
    });

    it('converts .prompt(name, description, schema, callback)', () => {
        const input = [
            `server.prompt('summarize', 'Summarize text', { text: z.string() }, async ({ text }) => {`,
            `    return { messages: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerPrompt');
        expect(result).toContain("description: 'Summarize text'");
        expect(result).toContain('argsSchema: z.object({ text: z.string() })');
    });

    it('is idempotent', () => {
        const input =
            MCP_IMPORT +
            [`server.tool('ping', async () => {`, `    return { content: [{ type: 'text', text: 'pong' }] };`, `});`, ''].join('\n');
        const project1 = new Project({ useInMemoryFileSystem: true });
        const sf1 = project1.createSourceFile('test.ts', input);
        mcpServerApiTransform.apply(sf1, ctx);
        const first = sf1.getFullText();

        const project2 = new Project({ useInMemoryFileSystem: true });
        const sf2 = project2.createSourceFile('test.ts', first);
        mcpServerApiTransform.apply(sf2, ctx);
        const second = sf2.getFullText();

        expect(second).toBe(first);
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

    it('wraps raw argsSchema in .registerPrompt() config', () => {
        const input = [
            `server.registerPrompt("args-prompt", { argsSchema: { city: z.string(), state: z.string().optional() } }, (args) => {`,
            `    return { messages: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('argsSchema: z.object({ city: z.string(), state: z.string().optional() })');
        expect(result).not.toContain('argsSchema: { city:');
    });

    it('wraps raw inputSchema in .registerTool() config', () => {
        const input = [
            `server.registerTool("echo", { inputSchema: { msg: z.string() } }, async ({ msg }) => {`,
            `    return { content: [{ type: 'text', text: msg }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('inputSchema: z.object({ msg: z.string() })');
        expect(result).not.toContain('inputSchema: { msg:');
    });

    it('does not double-wrap z.object() in .registerTool() config', () => {
        const input = [
            `server.registerTool("echo", { inputSchema: z.object({ msg: z.string() }) }, async ({ msg }) => {`,
            `    return { content: [{ type: 'text', text: msg }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('inputSchema: z.object({ msg: z.string() })');
        expect(result).not.toContain('z.object(z.object(');
    });

    it('does not double-wrap z.object() in .registerPrompt() config', () => {
        const input = [
            `server.registerPrompt("args-prompt", { argsSchema: z.object({ city: z.string() }) }, (args) => {`,
            `    return { messages: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('argsSchema: z.object({ city: z.string() })');
        expect(result).not.toContain('z.object(z.object(');
    });

    it('emits diagnostic for variable-valued schema in config', () => {
        const input = [
            `const promptArgsSchema = { city: z.string() };`,
            `server.registerPrompt("args-prompt", { argsSchema: promptArgsSchema }, (args) => {`,
            `    return { messages: [] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toContain('argsSchema: promptArgsSchema');
        expect(text).not.toContain('z.object(promptArgsSchema)');
        expect(result.diagnostics.some(d => d.message.includes('not an object literal'))).toBe(true);
    });

    it('emits diagnostic for shorthand schema property in config', () => {
        const input = [
            `server.registerTool("echo", { inputSchema }, async ({ msg }) => {`,
            `    return { content: [{ type: 'text', text: msg }] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toContain('{ inputSchema }');
        expect(result.diagnostics.some(d => d.message.includes('Shorthand'))).toBe(true);
    });

    it('leaves .registerTool() without inputSchema unchanged', () => {
        const input = [
            `server.registerTool("ping", {}, async () => {`,
            `    return { content: [{ type: 'text', text: 'pong' }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerTool("ping", {}');
        expect(result).not.toContain('z.object');
    });

    it('moves taskStore from top-level options into capabilities.tasks', () => {
        const input = `const server = new McpServer({ name: "test", version: "1.0" }, { taskStore, capabilities: { tasks: { list: {} } } });\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).not.toMatch(/,\s*taskStore\s*,\s*capabilities/);
        expect(text).toMatch(/tasks:\s*\{[\s\S]*taskStore/);
        expect(result.changesCount).toBeGreaterThan(0);
    });

    it('moves taskMessageQueue from top-level options into capabilities.tasks', () => {
        const input = `const server = new McpServer({ name: "test", version: "1.0" }, { taskMessageQueue, capabilities: { tasks: { list: {} } } });\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).not.toMatch(/,\s*taskMessageQueue\s*,\s*capabilities/);
        expect(text).toMatch(/tasks:\s*\{[\s\S]*taskMessageQueue/);
        expect(result.changesCount).toBeGreaterThan(0);
    });

    it('moves both taskStore and taskMessageQueue into capabilities.tasks', () => {
        const input = `const server = new McpServer({ name: "test", version: "1.0" }, { taskStore, taskMessageQueue, capabilities: { tasks: {} } });\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toMatch(/tasks:\s*\{[\s\S]*taskStore/);
        expect(text).toMatch(/tasks:\s*\{[\s\S]*taskMessageQueue/);
    });

    it('moves both task props with complex values without corrupting output', () => {
        const input = `const server = new McpServer({ name: "test", version: "1.0" }, { taskStore: createStore(a, b), taskMessageQueue: new Queue({ size: 10 }), capabilities: { tasks: {} } });\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toMatch(/tasks:\s*\{[\s\S]*taskStore:\s*createStore\(a, b\)/);
        expect(text).toMatch(/tasks:\s*\{[\s\S]*taskMessageQueue:\s*new Queue\(\{\s*size:\s*10\s*\}\)/);
        expect(text).toContain('capabilities');
    });

    it('emits warning when capabilities.tasks object is missing', () => {
        const input = `const server = new McpServer({ name: "test", version: "1.0" }, { taskStore, capabilities: {} });\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const taskWarnings = result.diagnostics.filter(d => d.message.includes('taskStore'));
        expect(taskWarnings.length).toBe(1);
        expect(taskWarnings[0]!.message).toContain('capabilities.tasks');
    });

    it('does not touch constructor without taskStore or taskMessageQueue', () => {
        const input = `const server = new McpServer({ name: "test", version: "1.0" }, { capabilities: {} });\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const taskWarnings = result.diagnostics.filter(d => d.message.includes('taskStore') || d.message.includes('taskMessageQueue'));
        expect(taskWarnings.length).toBe(0);
    });

    it('moves taskStore with complex value expression (nested braces/commas)', () => {
        const input = `const server = new McpServer({ name: "test", version: "1.0" }, { taskStore: new InMemoryTaskStore({ ttl: 5000 }), capabilities: { tasks: { list: {} } } });\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toMatch(/tasks:\s*\{[\s\S]*taskStore:\s*new InMemoryTaskStore\(\{\s*ttl:\s*5000\s*\}\)/);
        expect(text).not.toMatch(/,\s*taskStore.*capabilities/);
        expect(result.changesCount).toBeGreaterThan(0);
    });
});
