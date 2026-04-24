import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { importPathsTransform } from '../../../src/migrations/v1-to-v2/transforms/importPaths.js';
import type { TransformContext } from '../../../src/types.js';

function applyTransform(code: string, context: TransformContext = { projectType: 'both' }): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    importPathsTransform.apply(sourceFile, context);
    return sourceFile.getFullText();
}

describe('import-paths transform', () => {
    it('rewrites client imports to @modelcontextprotocol/client', () => {
        const input = `import { Client } from '@modelcontextprotocol/sdk/client/index.js';\n`;
        const result = applyTransform(input);
        expect(result).toContain(`from "@modelcontextprotocol/client"`);
        expect(result).toContain('Client');
        expect(result).not.toContain('@modelcontextprotocol/sdk');
    });

    it('rewrites server imports to @modelcontextprotocol/server', () => {
        const input = `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n`;
        const result = applyTransform(input);
        expect(result).toContain(`from "@modelcontextprotocol/server"`);
        expect(result).toContain('McpServer');
    });

    it('consolidates multiple SDK imports to same v2 package', () => {
        const input = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('Client');
        expect(result).toContain('StreamableHTTPClientTransport');
        const importLines = result.split('\n').filter(l => l.includes('@modelcontextprotocol/client'));
        expect(importLines.length).toBe(1);
    });

    it('rewrites server streamableHttp to @modelcontextprotocol/node with rename', () => {
        const input = `import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';\n`;
        const result = applyTransform(input);
        expect(result).toContain(`from "@modelcontextprotocol/node"`);
        expect(result).toContain('NodeStreamableHTTPServerTransport');
        expect(result).not.toMatch(/(?<!Node)StreamableHTTPServerTransport/);
    });

    it('removes websocket import with warning', () => {
        const input = `import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';\n`;
        const ctx: TransformContext = { projectType: 'client' };
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, ctx);
        expect(sourceFile.getFullText()).not.toContain('WebSocketClientTransport');
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('WebSocketClientTransport');
    });

    it('removes SSE server import with warning', () => {
        const input = `import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';\n`;
        const ctx: TransformContext = { projectType: 'server' };
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('SSE server transport');
    });

    it('resolves sdk/types.js based on sibling client imports', () => {
        const input = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'both' });
        expect(result).toContain(`from "@modelcontextprotocol/client"`);
        expect(result).toContain('CallToolResultSchema');
    });

    it('resolves sdk/types.js based on sibling server imports', () => {
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'both' });
        expect(result).toContain(`from "@modelcontextprotocol/server"`);
    });

    it('preserves type-only imports separately', () => {
        const input = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `import type { Tool } from '@modelcontextprotocol/sdk/types.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'client' });
        expect(result).toContain('import {');
        expect(result).toContain('import type {');
    });

    it('is idempotent', () => {
        const input = `import { Client } from '@modelcontextprotocol/sdk/client/index.js';\n`;
        const first = applyTransform(input);
        const second = applyTransform(first);
        expect(second).toBe(first);
    });

    it('skips files with no SDK imports', () => {
        const input = `import { something } from 'other-package';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'both' });
        expect(result.changesCount).toBe(0);
        expect(sourceFile.getFullText()).toBe(input);
    });

    it('rewrites middleware import to @modelcontextprotocol/express', () => {
        const input = `import { hostHeaderValidation } from '@modelcontextprotocol/sdk/server/middleware.js';\n`;
        const result = applyTransform(input);
        expect(result).toContain(`from "@modelcontextprotocol/express"`);
    });

    it('renames body references when renamedSymbols applies', () => {
        const input = [
            `import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';`,
            `const transport = new StreamableHTTPServerTransport({});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('new NodeStreamableHTTPServerTransport({})');
        expect(result).not.toMatch(/(?<!Node)StreamableHTTPServerTransport/);
    });

    it('preserves aliased imports', () => {
        const input = [
            `import { Client as MCPClient } from '@modelcontextprotocol/sdk/client/index.js';`,
            `const c = new MCPClient({});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('MCPClient');
        expect(result).toContain('@modelcontextprotocol/client');
        expect(result).toContain('new MCPClient({})');
    });

    it('preserves namespace imports by rewriting module specifier', () => {
        const input = [`import * as types from '@modelcontextprotocol/sdk/types.js';`, `const x: types.Tool = {};`, ''].join('\n');
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain('import * as types');
        expect(result).toContain('@modelcontextprotocol/server');
        expect(result).toContain('types.Tool');
    });

    it('preserves default imports by rewriting module specifier', () => {
        const input = [`import sdk from '@modelcontextprotocol/sdk/types.js';`, `const x = sdk.foo;`, ''].join('\n');
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain('import sdk');
        expect(result).toContain('@modelcontextprotocol/server');
    });

    it('handles aliased renamedSymbols correctly', () => {
        const input = [
            `import { StreamableHTTPServerTransport as SHST } from '@modelcontextprotocol/sdk/server/streamableHttp.js';`,
            `const t = new SHST({});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('NodeStreamableHTTPServerTransport as SHST');
        expect(result).toContain('new SHST({})');
        expect(result).toContain('@modelcontextprotocol/node');
    });

    it('emits warning for namespace import with renamedSymbols', () => {
        const input = [
            `import * as transport from '@modelcontextprotocol/sdk/server/streamableHttp.js';`,
            `const t = new transport.StreamableHTTPServerTransport({});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(sourceFile.getFullText()).toContain('import * as transport');
        expect(sourceFile.getFullText()).toContain('@modelcontextprotocol/node');
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics.some(d => d.message.includes('renamed') && d.message.includes('StreamableHTTPServerTransport'))).toBe(
            true
        );
    });

    it('removes auth imports with warning', () => {
        const input = `import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('auth removed');
    });
});
