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
        expect(result).toContain('ctx?.mcpReq.signal');
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

describe('trailing context parameter selection (B2)', () => {
    it('processes the 3-parameter registerResource template callback', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/server';`,
                `server.registerResource('r', template, {}, async (uri, variables, extra) => {`,
                `    const s = extra.signal;`,
                `    return { contents: [] };`,
                `});`,
                ''
            ].join('\n')
        );
        contextTypesTransform.apply(sourceFile, { projectType: 'server' });
        const text = sourceFile.getFullText();
        expect(text).toContain('(uri, variables, ctx)');
        expect(text).toContain('ctx.mcpReq.signal');
    });

    it('does not flag a destructured middle parameter when the trailing context is already named ctx', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/server';`,
                `server.registerResource('r', tpl, {}, async (uri, { id }, ctx) => ({ contents: [] }));`,
                ''
            ].join('\n')
        );
        const result = contextTypesTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.some(d => d.message.includes('Destructuring of context parameter'))).toBe(false);
    });

    it('still processes the 2-parameter form via index fallback', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/server';`,
                `server.registerTool('t', {}, async (args, extra) => {`,
                `    const s = extra.signal;`,
                `    return { content: [] };`,
                `});`,
                ''
            ].join('\n')
        );
        contextTypesTransform.apply(sourceFile, { projectType: 'server' });
        const text = sourceFile.getFullText();
        expect(text).toContain('(args, ctx)');
        expect(text).toContain('ctx.mcpReq.signal');
    });
});

describe('destructured trailing parameter key gate (B4)', () => {
    it('does not flag template-variable destructures', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/server';`,
                `server.registerResource('r', tpl, {}, async (uri, { owner, repo }) => ({ contents: [] }));`,
                ''
            ].join('\n')
        );
        const result = contextTypesTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.some(d => d.message.includes('Destructuring of context parameter'))).toBe(false);
    });

    it('flags renamed context destructures and requestInfo', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/server';`,
                `server.registerTool('a', {}, async (args, { signal: abort }) => ({ content: [] }));`,
                `server.registerTool('b', {}, async (args, { requestInfo }) => ({ content: [] }));`,
                ''
            ].join('\n')
        );
        const result = contextTypesTransform.apply(sourceFile, { projectType: 'server' });
        const flagged = result.diagnostics.filter(d => d.message.includes('Destructuring of context parameter'));
        expect(flagged).toHaveLength(2);
    });

    it('still flags destructures carrying context-like keys', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { McpServer } from '@modelcontextprotocol/server';`,
                `server.registerTool('t', {}, async (args, { signal, sessionId }) => ({ content: [] }));`,
                ''
            ].join('\n')
        );
        const result = contextTypesTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.some(d => d.message.includes('Destructuring of context parameter'))).toBe(true);
    });
});

describe('fallback handler and annotated context params (B5, #152)', () => {
    function apply(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = contextTypesTransform.apply(sourceFile, { projectType: 'server' });
        return { text: sourceFile.getFullText(), result };
    }
    const IMPORT = `import { McpServer } from '@modelcontextprotocol/server';\n`;

    it('remaps fallbackRequestHandler assignments', () => {
        const code =
            IMPORT +
            [
                `server.fallbackRequestHandler = async (request, extra) => {`,
                `    extra.sendNotification(note);`,
                `    return { ok: true };`,
                `};`,
                ''
            ].join('\n');
        const { text } = apply(code);
        expect(text).toContain('(request, ctx)');
        expect(text).toContain('ctx.mcpReq.notify(note)');
    });

    it('remaps accesses on parameters annotated with a context type alias', () => {
        const code =
            IMPORT +
            [
                `type ToolExtra = ServerContext;`,
                `class Host {`,
                `    private screenParty(args: unknown, extra: ToolExtra) {`,
                `        extra.sendRequest(req, schema);`,
                `        return extra.authInfo;`,
                `    }`,
                `}`,
                ''
            ].join('\n');
        const { text } = apply(code);
        expect(text).toContain('extra.mcpReq.send(req, schema)');
        expect(text).toContain('extra.http?.authInfo');
    });

    it('remaps direct ServerContext annotations on free functions', () => {
        const code = IMPORT + [`function helper(extra: ServerContext) {`, `    return extra.signal;`, `}`, ''].join('\n');
        const { text } = apply(code);
        expect(text).toContain('extra.mcpReq.signal');
    });

    it('does not remap shadowed inner parameters with the same name', () => {
        const code =
            IMPORT +
            [`function helper(extra: ServerContext) {`, `    return items.map((extra: ItemMeta) => extra.signal);`, `}`, ''].join('\n');
        const { text } = apply(code);
        expect(text).toContain('=> extra.signal');
        expect(text).not.toContain('mcpReq');
    });

    it('resolves alias-of-alias annotations and nullable widening', () => {
        const code =
            IMPORT +
            [
                `type A = ServerContext;`,
                `type B = A;`,
                `function h1(extra: B) { return extra.signal; }`,
                `function h2(extra: ServerContext | undefined) { return extra?.signal; }`,
                ''
            ].join('\n');
        const { text } = apply(code);
        expect(text).toContain('function h1(extra: B) { return extra.mcpReq.signal; }');
        expect(text).toContain('return extra?.mcpReq.signal;');
    });

    it('accepts direct aliases whose generic arguments contain unions', () => {
        const code = [
            `import { McpServer } from '@modelcontextprotocol/server';`,
            `type Extra = RequestHandlerExtra<ServerRequest | PingRequest, ServerNotification>;`,
            `function h(extra: Extra) {`,
            `    return extra.signal;`,
            `}`,
            ''
        ].join('\n');
        const { text } = apply(code);
        expect(text).toContain('extra.mcpReq.signal');
    });

    it('does not remap intersection aliases involving a context type', () => {
        const code = [
            `import { McpServer } from '@modelcontextprotocol/server';`,
            `type Augmented = ServerContext & { tenant: string };`,
            `function h(extra: Augmented) {`,
            `    return extra.signal;`,
            `}`,
            ''
        ].join('\n');
        const { text, result } = apply(code);
        expect(text).toContain('return extra.signal;');
        expect(result.diagnostics.some(d => d.message.includes('cannot remap'))).toBe(true);
    });

    it('does not remap wrapper aliases that merely mention a context type', () => {
        const code = [
            `import { McpServer } from '@modelcontextprotocol/server';`,
            `type ToolCallContext = { mcp: ServerContext; signal: AbortSignal };`,
            `function run(extra: ToolCallContext) {`,
            `    return extra.signal;`,
            `}`,
            ''
        ].join('\n');
        const { text, result } = apply(code);
        expect(text).toContain('return extra.signal;');
        expect(text).not.toContain('mcpReq');
        const advisory = result.diagnostics.find(d => d.message.includes('cannot remap'));
        expect(advisory).toBeDefined();
        expect(advisory?.advisoryOnly).toBe(true);
    });

    it('advises on context-mentioning annotations it cannot remap', () => {
        const code = IMPORT + [`function pool(extra: Map<string, ServerContext>) { return extra.size; }`, ''].join('\n');
        const { text, result } = apply(code);
        expect(text).toContain('return extra.size;');
        const diag = result.diagnostics.find(d => d.message.includes('cannot remap'));
        expect(diag).toBeDefined();
        expect(diag?.advisoryOnly).toBe(true);
    });

    it('preserves optional chaining in processed callbacks', () => {
        const code =
            IMPORT +
            [
                `server.registerTool('t', {}, async (args, extra) => {`,
                `    return { content: [], note: extra?.sessionId };`,
                `});`,
                ''
            ].join('\n');
        const { text } = apply(code);
        expect(text).toContain('ctx?.sessionId');
    });

    it('notes contexts forwarded wholesale to helpers', () => {
        const code =
            IMPORT +
            [
                `server.registerTool('t', {}, async (args, extra) => {`,
                `    if (!hasScope(extra)) throw new Error('denied');`,
                `    return { content: [] };`,
                `});`,
                ''
            ].join('\n');
        const { result } = apply(code);
        const diag = result.diagnostics.find(d => d.message.includes('forwarded to hasScope'));
        expect(diag).toBeDefined();
        expect(diag?.advisoryOnly).toBe(true);
    });
});
