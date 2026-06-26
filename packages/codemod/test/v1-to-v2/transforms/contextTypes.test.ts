import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { contextTypesTransform } from '../../../src/migrations/v1-to-v2/transforms/contextTypes';
import type { TransformContext } from '../../../src/types';

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

    it('does not rename "extra" inside string literals', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const msg = 'this is extra info';`,
            `    const s = extra.signal;`,
            `    return { content: [{ type: 'text', text: msg }] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("'this is extra info'");
        expect(result).toContain('ctx.mcpReq.signal');
        expect(result).toContain('(request, ctx)');
    });

    it('does not rename "extra" as property name on unrelated object', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const meta = request.params._meta;`,
            `    if (meta?.extra) { console.log(meta.extra); }`,
            `    const s = extra.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('meta?.extra');
        expect(result).toContain('meta.extra');
        expect(result).toContain('ctx.mcpReq.signal');
        expect(result).not.toContain('meta?.ctx');
        expect(result).not.toContain('meta.ctx');
    });

    it('expands shorthand property assignment when renaming extra to ctx', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    helper({ request, extra });`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('extra: ctx');
        expect(result).not.toContain('{ request, extra }');
        expect(result).toContain('(request, ctx)');
    });

    it('does not rename "extra" as binding element property name', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    const { extra: val } = unrelatedObj;`,
            `    const s = extra.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('{ extra: val }');
        expect(result).not.toContain('{ ctx: val }');
        expect(result).toContain('ctx.mcpReq.signal');
    });

    it('rewrites typeof ctx.sendRequest in type positions', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    type Send = Parameters<typeof extra.sendRequest>;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('typeof ctx.mcpReq.send');
        expect(result).not.toContain('typeof ctx.sendRequest');
        expect(result).not.toContain('extra');
    });

    // #152 — as-cast/parenthesized callbacks were skipped (the callback arg is an AsExpression, not the
    // arrow function), leaving `extra.authInfo` etc. in code that type-checks via the cast and only
    // fails at runtime.
    it('#152 — remaps an as-cast/parenthesized registerTool callback', () => {
        const input = [
            `server.registerTool('issue', { inputSchema: z.object({}) }, (async (args, extra) => {`,
            `    if (!extra.authInfo) throw new Error('no auth');`,
            `    return { content: [] };`,
            `}) as Parameters<McpServer['registerTool']>[2]);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('(args, ctx)');
        expect(result).toContain('ctx.http?.authInfo');
        expect(result).not.toContain('extra.authInfo');
    });

    // #152 — `protocol.fallbackRequestHandler = async (request, extra) => …` is an assignment, not a
    // call, so the call-site scan never reached it.
    it('#152 — remaps a fallbackRequestHandler assignment', () => {
        const input = [
            `server.fallbackRequestHandler = async (request, extra) => {`,
            `    await extra.sendNotification({ method: 'test' });`,
            `    return {};`,
            `};`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('(request, ctx)');
        expect(result).toContain('ctx.mcpReq.notify');
    });

    // #152 — helpers a callback forwards its context to (or any parameter explicitly typed
    // ServerContext/ClientContext) are not remapped automatically; emit a site-level marker so the
    // stale property access is visible in the diff instead of silently breaking at runtime.
    it('#152 — marks v1 property accesses on a parameter typed ServerContext that the remap could not reach', () => {
        const input = [
            `import type { ServerContext } from '@modelcontextprotocol/server';`,
            `function helper(extra: ServerContext) {`,
            `    return extra.sendRequest({ method: 'x' }, S);`,
            `}`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', MCP_IMPORT + input);
        const result = contextTypesTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.some(d => d.insertComment && d.message.includes('.sendRequest'))).toBe(true);
    });

    // #122 — a schema-less McpServer registerTool callback receives the context as its ONLY parameter;
    // the remap previously required a second parameter and skipped these.
    it('#122 — remaps a single-parameter (context-only) registerTool callback', () => {
        const input = [
            `server.registerTool('ping', {}, async (extra) => {`,
            `    const m = extra._meta;`,
            `    await extra.sendNotification({ method: 'test' });`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('async (ctx)');
        expect(result).toContain('ctx.mcpReq._meta');
        expect(result).toContain('ctx.mcpReq.notify');
    });

    it('rewrites typeof ctx.signal in type positions', () => {
        const input = [
            `server.setRequestHandler('tools/call', async (request, extra) => {`,
            `    type Sig = typeof extra.signal;`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('typeof ctx.mcpReq.signal');
        expect(result).not.toContain('typeof ctx.signal');
        expect(result).not.toContain('extra');
    });
});
