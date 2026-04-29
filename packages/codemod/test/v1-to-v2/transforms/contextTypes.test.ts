import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { contextTypesTransform } from '../../../src/migrations/v1-to-v2/transforms/contextTypes.js';
import type { TransformContext } from '../../../src/types.js';

const ctx: TransformContext = { projectType: 'server' };

const MCP_IMPORT = `import { McpServer } from '@modelcontextprotocol/server';\n`;

function applyTransform(code: string): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + code);
    contextTypesTransform.apply(sourceFile, ctx);
    return sourceFile.getFullText();
}

describe('context-types transform', () => {
    it('renames extra parameter to ctx in setRequestHandler', () => {
        const input = [`server.setRequestHandler('tools/call', async (request, extra) => {`, `    return { content: [] };`, `});`, ''].join(
            '\n'
        );
        const result = applyTransform(input);
        expect(result).toContain('(request, ctx)');
        expect(result).not.toContain('extra');
    });

    it('rewrites extra.signal to ctx.mcpReq.signal', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const s = extra.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ctx.mcpReq.signal');
    });

    it('rewrites extra.requestId to ctx.mcpReq.id', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const id = extra.requestId;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ctx.mcpReq.id');
    });

    it('rewrites extra.sendNotification to ctx.mcpReq.notify', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    await extra.sendNotification({ method: 'test', params: {} });`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ctx.mcpReq.notify(');
    });

    it('rewrites extra.sendRequest to ctx.mcpReq.send', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    await extra.sendRequest({ method: 'test', params: {} });`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ctx.mcpReq.send(');
    });

    it('rewrites extra.authInfo to ctx.http?.authInfo', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const auth = extra.authInfo;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ctx.http?.authInfo');
    });

    it('rewrites extra.taskStore to ctx.task?.store', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const store = extra.taskStore;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ctx.task?.store');
    });

    it('does not touch non-extra parameters', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, context) => {`,
            `    const s = context.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('context.signal');
        expect(result).not.toContain('ctx');
    });

    it('does not rewrite properties that are prefixes of other properties', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const s = extra.signal;`,
            `    const h = extra.signalHandler;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ctx.mcpReq.signal');
        expect(result).toContain('ctx.signalHandler');
        expect(result).not.toContain('ctx.mcpReq.signalHandler');
    });

    it('emits warning when context parameter is destructured in body', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const { signal, authInfo } = extra;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = contextTypesTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('Destructuring');
    });

    it('emits warning when context parameter is destructured in signature', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, { signal, authInfo }) => {`,
            `    if (signal.aborted) return;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = contextTypesTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('Destructuring');
        expect(result.diagnostics[0]!.message).toContain('signal');
    });

    it('works with registerTool callbacks', () => {
        const input = [
            `server.registerTool('test', {}, async (args, extra) => {`,
            `    const s = extra.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ctx.mcpReq.signal');
    });

    it('does not transform files without MCP imports', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const s = extra.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = contextTypesTransform.apply(sourceFile, ctx);
        expect(result.changesCount).toBe(0);
        expect(sourceFile.getFullText()).toContain('extra.signal');
    });

    it('emits warning when another parameter is already named ctx', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (ctx, extra) => {`,
            `    const s = extra.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = contextTypesTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('another parameter');
        expect(sourceFile.getFullText()).toContain('extra.signal');
    });

    it('emits warning when ctx variable already exists in scope', () => {
        const input = [
            `const ctx = getApplicationContext();`,
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    console.log(ctx.appName);`,
            `    const s = extra.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = contextTypesTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('ctx');
        expect(result.diagnostics[0]!.message).toContain('already referenced');
        expect(sourceFile.getFullText()).toContain('extra.signal');
    });

    it('handles optional chaining on context properties', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const s = extra?.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ctx.mcpReq.signal');
        expect(result).not.toContain('extra');
    });

    it('renames extra to ctx in 2-arg tool(name, callback) calls', () => {
        const input = [
            `server.tool('greet', async (request, extra) => {`,
            `    const s = extra.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('async (request, ctx)');
        expect(result).toContain('ctx.mcpReq.signal');
        expect(result).not.toContain('extra');
    });

    it('renames extra to ctx in setNotificationHandler callbacks', () => {
        const input = [
            `server.setNotificationHandler('notifications/cancelled', (notification, extra) => {`,
            `    const s = extra.sessionId;`,
            `    console.log(notification);`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('(notification, ctx)');
        expect(result).toContain('ctx.sessionId');
        expect(result).not.toContain('extra');
    });

    it('does not inflate change count for identity mappings like sessionId', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const id = extra.sessionId;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = contextTypesTransform.apply(sourceFile, ctx);
        expect(result.changesCount).toBe(1);
        expect(sourceFile.getFullText()).toContain('ctx.sessionId');
    });

    it('renames extra to ctx even when nested arrow function has its own ctx param', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const items = [1, 2, 3];`,
            `    const mapped = items.map((item, ctx) => ctx + item);`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('(request, ctx)');
        expect(result).toContain('items.map((item, ctx) => ctx + item)');
    });

    it('still warns when ctx is a free variable from outer scope', () => {
        const input = [
            `const ctx = { custom: true };`,
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    console.log(ctx.custom);`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = contextTypesTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.some(d => d.message.includes('already referenced'))).toBe(true);
        expect(sourceFile.getFullText()).toContain('extra');
    });
});
