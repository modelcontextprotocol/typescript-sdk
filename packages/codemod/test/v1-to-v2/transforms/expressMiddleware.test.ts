import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { expressMiddlewareTransform } from '../../../src/migrations/v1-to-v2/transforms/expressMiddleware.js';
import type { TransformContext } from '../../../src/types.js';

const ctx: TransformContext = { projectType: 'server' };

function applyTransform(code: string) {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    const result = expressMiddlewareTransform.apply(sourceFile, ctx);
    return { text: sourceFile.getFullText(), result };
}

describe('express-middleware transform', () => {
    it('rewrites hostHeaderValidation({ allowedHosts: [...] }) to hostHeaderValidation([...])', () => {
        const input = [
            `import { hostHeaderValidation } from '@modelcontextprotocol/express';`,
            `app.use(hostHeaderValidation({ allowedHosts: ['localhost', '127.0.0.1'] }));`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain("hostHeaderValidation(['localhost', '127.0.0.1'])");
        expect(text).not.toContain('allowedHosts');
        expect(result.changesCount).toBe(1);
    });

    it('preserves calls that already use array syntax', () => {
        const input = [
            `import { hostHeaderValidation } from '@modelcontextprotocol/express';`,
            `app.use(hostHeaderValidation(['localhost', '127.0.0.1']));`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain("hostHeaderValidation(['localhost', '127.0.0.1'])");
        expect(result.changesCount).toBe(0);
    });

    it('handles variable references in allowedHosts', () => {
        const input = [
            `import { hostHeaderValidation } from '@modelcontextprotocol/express';`,
            `const hosts = ['localhost'];`,
            `app.use(hostHeaderValidation({ allowedHosts: hosts }));`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain('hostHeaderValidation(hosts)');
        expect(text).not.toContain('allowedHosts');
        expect(result.changesCount).toBe(1);
    });

    it('does not modify calls with non-object arguments', () => {
        const input = [
            `import { hostHeaderValidation } from '@modelcontextprotocol/express';`,
            `app.use(hostHeaderValidation(someVariable));`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain('hostHeaderValidation(someVariable)');
        expect(result.changesCount).toBe(0);
    });

    it('does not modify calls with no arguments', () => {
        const input = [
            `import { hostHeaderValidation } from '@modelcontextprotocol/express';`,
            `app.use(hostHeaderValidation());`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(text).toContain('hostHeaderValidation()');
        expect(result.changesCount).toBe(0);
    });

    it('is idempotent', () => {
        const input = [
            `import { hostHeaderValidation } from '@modelcontextprotocol/express';`,
            `app.use(hostHeaderValidation({ allowedHosts: ['localhost'] }));`,
            ''
        ].join('\n');
        const { text: first } = applyTransform(input);
        const { text: second } = applyTransform(first);
        expect(second).toBe(first);
    });

    it('does not modify calls when hostHeaderValidation is not from MCP', () => {
        const input = [
            `import { hostHeaderValidation } from './my-middleware.js';`,
            `app.use(hostHeaderValidation({ allowedHosts: ['localhost'] }));`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(result.changesCount).toBe(0);
        expect(text).toContain("{ allowedHosts: ['localhost'] }");
    });

    it('does not modify non-MCP hostHeaderValidation even when other MCP imports exist', () => {
        const input = [
            `import { McpServer } from '@modelcontextprotocol/server';`,
            `import { hostHeaderValidation } from './my-middleware.js';`,
            `app.use(hostHeaderValidation({ allowedHosts: ['localhost'] }));`,
            ''
        ].join('\n');
        const { text, result } = applyTransform(input);
        expect(result.changesCount).toBe(0);
        expect(text).toContain("{ allowedHosts: ['localhost'] }");
    });
});
