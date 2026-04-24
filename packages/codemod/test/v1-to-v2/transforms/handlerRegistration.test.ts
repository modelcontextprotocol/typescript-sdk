import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { handlerRegistrationTransform } from '../../../src/migrations/v1-to-v2/transforms/handlerRegistration.js';
import type { TransformContext } from '../../../src/types.js';

const ctx: TransformContext = { projectType: 'server' };

function applyTransform(code: string): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    handlerRegistrationTransform.apply(sourceFile, ctx);
    return sourceFile.getFullText();
}

describe('handler-registration transform', () => {
    it('replaces CallToolRequestSchema with method string', () => {
        const input = [
            `import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(CallToolRequestSchema, async (request) => {`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("setRequestHandler('tools/call'");
        expect(result).not.toContain('CallToolRequestSchema');
    });

    it('replaces notification schema with method string', () => {
        const input = [
            `import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {`,
            `    console.log(notification);`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("setNotificationHandler('notifications/message'");
        expect(result).not.toContain('LoggingMessageNotificationSchema');
    });

    it('removes unused schema import after replacement', () => {
        const input = [
            `import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(CallToolRequestSchema, async (request) => {`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).not.toContain('CallToolRequestSchema');
    });

    it('keeps import if schema is referenced elsewhere', () => {
        const input = [
            `import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(CallToolRequestSchema, async (request) => {`,
            `    return { content: [] };`,
            `});`,
            `console.log(CallToolRequestSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("setRequestHandler('tools/call'");
        expect(result).toContain('import { CallToolRequestSchema }');
    });

    it('is idempotent', () => {
        const input = [
            `import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(CallToolRequestSchema, async (request) => {`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const first = applyTransform(input);
        const second = applyTransform(first);
        expect(second).toBe(first);
    });

    it('handles multiple schema replacements in one file', () => {
        const input = [
            `import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));`,
            `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("'tools/call'");
        expect(result).toContain("'tools/list'");
    });

    it('does not replace schema identifiers from non-MCP packages', () => {
        const input = [
            `import { CallToolRequestSchema } from './local-schemas.js';`,
            `server.setRequestHandler(CallToolRequestSchema, async (request) => {`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('CallToolRequestSchema');
        expect(result).not.toContain("'tools/call'");
    });

    it('does not rewrite local import when aliased MCP import has same export name', () => {
        const input = [
            `import { CallToolRequestSchema } from './local-schemas.js';`,
            `import { CallToolRequestSchema as McpSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));`,
            `validateSchema(McpSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("from './local-schemas.js'");
        expect(result).toContain('setRequestHandler(CallToolRequestSchema');
        expect(result).not.toContain("'tools/call'");
    });

    it('replaces ListRootsRequestSchema with method string', () => {
        const input = [
            `import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [] }));`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("'roots/list'");
        expect(result).not.toContain('ListRootsRequestSchema');
    });

    it('replaces RootsListChangedNotificationSchema with method string', () => {
        const input = [
            `import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("'notifications/roots/list_changed'");
        expect(result).not.toContain('RootsListChangedNotificationSchema');
    });

    it('handles aliased schema imports', () => {
        const input = [
            `import { CallToolRequestSchema as CTRS } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(CTRS, async (request) => {`,
            `    return { content: [] };`,
            `});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("'tools/call'");
        expect(result).not.toContain('CTRS');
    });
});
