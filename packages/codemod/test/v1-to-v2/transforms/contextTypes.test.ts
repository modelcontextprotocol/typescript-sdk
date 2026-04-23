import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { contextTypesTransform } from '../../../src/migrations/v1-to-v2/transforms/contextTypes.js';
import type { TransformContext } from '../../../src/types.js';

const ctx: TransformContext = { projectType: 'server' };

function applyTransform(code: string): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
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
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = contextTypesTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('Destructuring');
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
});
