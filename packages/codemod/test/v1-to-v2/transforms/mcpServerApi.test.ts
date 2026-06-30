import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { mcpServerApiTransform } from '../../../src/migrations/v1-to-v2/transforms/mcpServerApi';
import type { TransformContext } from '../../../src/types';

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

    it('handles template expression description in .tool()', () => {
        const input = [
            "server.tool('greet', `Hello ${world}`, { name: z.string() }, async ({ name }) => {",
            `    return { content: [{ type: 'text', text: name }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('registerTool');
        expect(result).toContain('description: `Hello ${world}`');
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

    it('wraps raw outputSchema in .registerTool() config', () => {
        const input = [
            `server.registerTool("echo", { outputSchema: { result: z.string() } }, async () => {`,
            `    return { content: [], structuredContent: { result: 'ok' } };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('outputSchema: z.object({ result: z.string() })');
        expect(result).not.toContain('outputSchema: { result:');
    });

    it('wraps both raw inputSchema and outputSchema in the same .registerTool() config', () => {
        const input = [
            `server.registerTool("echo", { inputSchema: { msg: z.string() }, outputSchema: { result: z.string() } }, async ({ msg }) => {`,
            `    return { content: [], structuredContent: { result: msg } };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('inputSchema: z.object({ msg: z.string() })');
        expect(result).toContain('outputSchema: z.object({ result: z.string() })');
        expect(result).not.toContain('z.object(z.object(');
    });

    it('does not double-wrap z.object() outputSchema in .registerTool() config', () => {
        const input = [
            `server.registerTool("echo", { outputSchema: z.object({ result: z.string() }) }, async () => {`,
            `    return { content: [], structuredContent: { result: 'ok' } };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('outputSchema: z.object({ result: z.string() })');
        expect(result).not.toContain('z.object(z.object(');
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

    it('flags the variable-valued schema advisory as advisory-only', () => {
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
        const advisory = result.diagnostics.find(d => d.message.includes('Could not verify'));
        expect(advisory).toBeDefined();
        // The runner drops advisory-only diagnostics for files no transform changed,
        // so re-runs over migrated trees stay quiet while first runs keep them.
        expect(advisory?.advisoryOnly).toBe(true);
    });

    it('flags the shorthand schema advisory as advisory-only', () => {
        const input = [`const inputSchema = mySchema;`, `server.registerTool("t", { inputSchema }, cb);`, ''].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const advisory = result.diagnostics.find(d => d.message.includes('Shorthand'));
        expect(advisory).toBeDefined();
        expect(advisory?.advisoryOnly).toBe(true);
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

    it('flags taskStore in McpServer options as removed without modifying code', () => {
        const input = [
            `const server = new McpServer(`,
            `    { name: 'test', version: '1.0' },`,
            `    { taskStore: new InMemoryTaskStore() }`,
            `);`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(sourceFile.getFullText()).toBe(MCP_IMPORT + input);
        const taskDiags = result.diagnostics.filter(d => d.message.includes("'taskStore'"));
        expect(taskDiags).toHaveLength(1);
        expect(taskDiags[0]!.message).toContain('experimental tasks removed in v2 (SEP-2663');
        expect(taskDiags[0]!.message).toContain('No v2 equivalent');
        expect(taskDiags[0]!.insertComment).toBe(true);
    });

    it('flags each task option separately when both are present', () => {
        const input = [
            `const server = new McpServer(`,
            `    { name: 'test', version: '1.0' },`,
            `    { taskStore: store, taskMessageQueue: queue }`,
            `);`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(sourceFile.getFullText()).toBe(MCP_IMPORT + input);
        expect(result.diagnostics.some(d => d.message.includes("'taskStore'"))).toBe(true);
        expect(result.diagnostics.some(d => d.message.includes("'taskMessageQueue'"))).toBe(true);
    });

    it('does not move task options into capabilities.tasks even when present', () => {
        const input = [
            `const server = new McpServer(`,
            `    { name: 'test', version: '1.0' },`,
            `    { taskStore: store, capabilities: { tasks: {} } }`,
            `);`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(sourceFile.getFullText()).toBe(MCP_IMPORT + input);
        expect(sourceFile.getFullText()).toContain('taskStore: store');
        expect(result.diagnostics.some(d => d.message.includes("'taskStore'"))).toBe(true);
    });

    it('emits no task diagnostics for McpServer options without task options', () => {
        const input = [`const server = new McpServer({ name: 'test', version: '1.0' }, { instructions: 'hi' });`, ''].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(result.diagnostics).toHaveLength(0);
    });
});

describe('zod import injection for wrapped shapes (sweep rollup)', () => {
    it('adds the zod import when wrapping in a file without a z binding', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/server';`,
                `server.registerTool('t', { inputSchema: { name: nameSchema } }, cb);`,
                ''
            ].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, { projectType: 'server' });
        const text = sourceFile.getFullText();
        expect(text).toContain('z.object(');
        expect(text).toContain(`import { z } from "zod"`);
        expect(result.diagnostics.some(d => d.message.includes('Added `import { z }'))).toBe(true);
    });

    it('marks a non-import z binding instead of redeclaring it', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/server';`,
                `const { z } = require('zod');`,
                `server.registerTool('t', { inputSchema: { name: nameSchema } }, cb);`,
                ''
            ].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, { projectType: 'server' });
        expect(sourceFile.getFullText()).not.toContain(`import { z } from "zod"`);
        expect(result.diagnostics.some(d => d.insertComment && d.message.includes('not a value import from zod'))).toBe(true);
    });

    it('does not treat a type-only z import as a usable binding', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/server';`,
                `import type { z as zt } from 'zod';`,
                `server.registerTool('t', { inputSchema: { name: nameSchema } }, cb);`,
                ''
            ].join('\n')
        );
        mcpServerApiTransform.apply(sourceFile, { projectType: 'server' });
        expect(sourceFile.getFullText()).toContain(`import { z } from "zod"`);
    });

    it('does not add a second import when z is already bound', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/server';`,
                `import * as z from 'zod/v4';`,
                `server.registerTool('t', { inputSchema: { name: z.string() } }, cb);`,
                ''
            ].join('\n')
        );
        mcpServerApiTransform.apply(sourceFile, { projectType: 'server' });
        const text = sourceFile.getFullText();
        expect(text.match(/from ['"]zod/g)?.length).toBe(1);
    });
});

describe('nested and harness registrations (B4)', () => {
    it('migrates a registration nested inside another handler without crashing', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `server.tool('outer', { x: z.string() }, async (args) => {`,
                `    server.tool('inner', { y: z.number() }, async () => ({ content: [] }));`,
                `    return { content: [] };`,
                `});`,
                ''
            ].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(result.changesCount).toBeGreaterThan(0);
        expect(text).toContain(`registerTool('outer'`);
        expect(text).toContain(`registerTool('inner'`);
        expect(text).not.toContain('server.tool(');
    });

    it('migrates legacy calls on property-access receivers without a direct McpServer import', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
                `harness.mcp.tool('t', { x: z.string() }, async () => ({ content: [] }));`,
                ''
            ].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(sourceFile.getFullText()).toContain(`registerTool('t'`);
        expect(result.changesCount).toBeGreaterThan(0);
    });

    it('migrates cross-category nesting (a .prompt() inside a .tool() handler)', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `server.tool('outer', { x: z.string() }, async () => {`,
                `    server.prompt('greet', { name: z.string() }, cb);`,
                `    return { content: [] };`,
                `});`,
                ''
            ].join('\n')
        );
        mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toContain(`registerTool('outer'`);
        expect(text).toContain(`registerPrompt('greet'`);
        expect(text).not.toContain('server.prompt(');
    });

    it('stays silent on shape-mismatched calls in fallback mode (2-arg .resource())', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [`import type { Tool } from '@modelcontextprotocol/sdk/types.js';`, `router.resource('users', usersController);`, ''].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(sourceFile.getFullText()).toContain(`router.resource('users', usersController)`);
        expect(result.diagnostics.some(d => d.message.includes('Could not automatically migrate'))).toBe(false);
    });

    it('does not rewrite shape-identical non-MCP calls when the receiver type is unknown', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import type { Tool } from '@modelcontextprotocol/sdk/types.js';`,
                `const name = await cli.prompt('What is your name?', validateName);`,
                `app.resource('users', '/api/users', usersHandler);`,
                `registry.tool('hammer', { weight: 2 }, describeTool);`,
                ''
            ].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toContain(`cli.prompt('What is your name?', validateName)`);
        expect(text).toContain(`app.resource('users', '/api/users', usersHandler)`);
        expect(text).toContain(`registry.tool('hammer'`);
        expect(text).not.toContain('register');
        expect(result.diagnostics).toHaveLength(0);
    });

    it('does not rewrite members hanging off a server-named receiver', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import type { Tool } from '@modelcontextprotocol/sdk/types.js';`,
                `this.server.cli.prompt('What is your name?', validateName);`,
                `ctx.server.app.resource('users', '/api/users', usersHandler);`,
                `observer.tool('t', { x: z.string() }, cb);`,
                ''
            ].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toContain(`this.server.cli.prompt('What is your name?', validateName)`);
        expect(text).toContain(`ctx.server.app.resource('users'`);
        expect(text).toContain(`observer.tool('t'`);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('migrates wrapped and word-named server receivers without a direct McpServer import', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import type { Tool } from '@modelcontextprotocol/sdk/types.js';`,
                `this.server!.tool('a', { x: z.string() }, cb);`,
                `mockServer.prompt('b', cb);`,
                `(testServer as any).resource('c', 'uri://c', readCb);`,
                ''
            ].join('\n')
        );
        mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toContain(`registerTool('a'`);
        expect(text).toContain(`registerPrompt('b'`);
        expect(text).toContain(`registerResource('c'`);
    });

    it('does not wrap register* schemas on non-MCP receivers in fallback mode', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import type { Tool } from '@modelcontextprotocol/sdk/types.js';`,
                `registry.registerTool('hammer', { inputSchema: { weight: z.number() } }, describeTool);`,
                ''
            ].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toContain('inputSchema: { weight: z.number() }');
        expect(text).not.toContain('z.object');
        expect(result.diagnostics).toHaveLength(0);
    });

    it('still wraps register* schemas on mcp-named receivers in fallback mode', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import type { Tool } from '@modelcontextprotocol/sdk/types.js';`,
                `mockServer.registerTool('t', { inputSchema: { a: z.string() } }, cb);`,
                ''
            ].join('\n')
        );
        mcpServerApiTransform.apply(sourceFile, ctx);
        expect(sourceFile.getFullText()).toContain('inputSchema: z.object({ a: z.string() })');
    });

    it('still migrates mcp-named receivers without a direct McpServer import', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import type { Tool } from '@modelcontextprotocol/sdk/types.js';`,
                `this.mcpServer.tool('a', { x: z.string() }, cb);`,
                `server.prompt('b', cb);`,
                ''
            ].join('\n')
        );
        mcpServerApiTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).toContain(`registerTool('a'`);
        expect(text).toContain(`registerPrompt('b'`);
    });

    it('stays silent on non-matching .tool() shapes when the receiver type is unknown', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [`import { Client } from '@modelcontextprotocol/sdk/client/index.js';`, `toolbox.tool('hammer');`, ''].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(sourceFile.getFullText()).toContain(`toolbox.tool('hammer')`);
        expect(result.diagnostics.some(d => d.message.includes('Could not automatically migrate'))).toBe(false);
    });
});

describe('mock call-shape assertions (B6, #41)', () => {
    it('notes objectContaining assertions pinning a registration schema', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `expect(register).toHaveBeenCalledWith('t', expect.objectContaining({ inputSchema: { x: expectAny } }), cb);`,
                ''
            ].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        const diag = result.diagnostics.find(d => d.message.includes('Call-shape assertion'));
        expect(diag).toBeDefined();
        expect(diag?.advisoryOnly).toBe(true);
    });

    it('ignores objectContaining without schema keys', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `expect(fn).toHaveBeenCalledWith(expect.objectContaining({ title: 'x' }));`,
                ''
            ].join('\n')
        );
        const result = mcpServerApiTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.some(d => d.message.includes('Call-shape assertion'))).toBe(false);
    });
});
