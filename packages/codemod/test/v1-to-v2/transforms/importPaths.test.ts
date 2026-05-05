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

    it('splits streamableHttp import: transport to /node, types to /server', () => {
        const input = [
            `import { StreamableHTTPServerTransport, EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('NodeStreamableHTTPServerTransport');
        expect(result).toContain('@modelcontextprotocol/node');
        expect(result).toContain('EventStore');
        expect(result).toContain('@modelcontextprotocol/server');
        expect(result).not.toContain('@modelcontextprotocol/sdk');
    });

    it('splits streamableHttp type import: transport to /node, types to /server', () => {
        const input = [
            `import type { StreamableHTTPServerTransport, EventStore, StreamId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('NodeStreamableHTTPServerTransport');
        expect(result).toContain('@modelcontextprotocol/node');
        expect(result).toContain('EventStore');
        expect(result).toContain('StreamId');
        expect(result).toContain('@modelcontextprotocol/server');
    });

    it('rewrites client stdio to @modelcontextprotocol/client/stdio subpath', () => {
        const input = `import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';\n`;
        const result = applyTransform(input);
        expect(result).toContain(`from "@modelcontextprotocol/client/stdio"`);
        expect(result).toContain('StdioClientTransport');
        expect(result).not.toContain('@modelcontextprotocol/sdk');
    });

    it('routes all client stdio symbols to /stdio subpath', () => {
        const input = [
            `import { StdioClientTransport, DEFAULT_INHERITED_ENV_VARS, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('StdioClientTransport');
        expect(result).toContain('DEFAULT_INHERITED_ENV_VARS');
        expect(result).toContain('getDefaultEnvironment');
        expect(result).toContain('@modelcontextprotocol/client/stdio');
        expect(result).not.toContain('@modelcontextprotocol/sdk');
    });

    it('routes type-only StdioServerParameters to /stdio subpath', () => {
        const input = `import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';\n`;
        const result = applyTransform(input);
        expect(result).toContain('StdioServerParameters');
        expect(result).toContain('@modelcontextprotocol/client/stdio');
    });

    it('rewrites server stdio to @modelcontextprotocol/server/stdio subpath', () => {
        const input = `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';\n`;
        const result = applyTransform(input);
        expect(result).toContain(`from "@modelcontextprotocol/server/stdio"`);
        expect(result).toContain('StdioServerTransport');
        expect(result).not.toContain('@modelcontextprotocol/sdk');
    });

    it('preserves alias for client stdio import and routes to subpath', () => {
        const input = [
            `import { StdioClientTransport as T } from '@modelcontextprotocol/sdk/client/stdio.js';`,
            `const transport = new T({});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('@modelcontextprotocol/client/stdio');
        expect(result).toContain('StdioClientTransport as T');
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
        expect(sourceFile.getFullText()).toContain('@modelcontextprotocol/server');
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics.some(d => d.message.includes('renamed') && d.message.includes('StreamableHTTPServerTransport'))).toBe(
            true
        );
    });

    it('rewrites re-export with renamedSymbols and preserves public name', () => {
        const input = `export { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';\n`;
        const result = applyTransform(input);
        expect(result).toContain('@modelcontextprotocol/node');
        expect(result).toContain('NodeStreamableHTTPServerTransport as StreamableHTTPServerTransport');
    });

    it('removes auth imports with warning', () => {
        const input = `import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('auth router removed');
    });

    it('handles per-specifier type modifiers', () => {
        const input = [
            `import { McpServer, type ServerContext } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `const s = new McpServer({});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toMatch(/import\s*\{[^}]*McpServer[^}]*\}\s*from\s*['"]@modelcontextprotocol\/server['"]/);
        expect(result).toMatch(/import\s+type\s*\{[^}]*ServerContext[^}]*\}\s*from\s*['"]@modelcontextprotocol\/server['"]/);
    });

    it('does not crash when value import merges into existing import', () => {
        const input = [
            `import { Client } from '@modelcontextprotocol/client';`,
            `import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';`,
            `import type { Tool } from '@modelcontextprotocol/sdk/types.js';`,
            `const c = new Client({});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'client' });
        expect(result.changesCount).toBeGreaterThan(0);
        const output = sourceFile.getFullText();
        expect(output).toContain('@modelcontextprotocol/client');
        expect(output).not.toContain('@modelcontextprotocol/sdk');
    });

    it('applies SIMPLE_RENAMES to re-export specifiers', () => {
        const input = `export { McpError, ResourceReference } from '@modelcontextprotocol/sdk/types.js';\n`;
        const result = applyTransform(input);
        expect(result).toContain('ProtocolError as McpError');
        expect(result).toContain('ResourceTemplateReference as ResourceReference');
        expect(result).toContain('@modelcontextprotocol/server');
    });

    it('emits warning for re-exported ErrorCode', () => {
        const input = `export { ErrorCode } from '@modelcontextprotocol/sdk/types.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('ErrorCode');
        expect(result.diagnostics[0]!.message).toContain('split');
    });

    it('emits warning for re-exported RequestHandlerExtra', () => {
        const input = `export { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('RequestHandlerExtra');
    });

    it('emits warning for aliased import mixing symbols from different v2 packages', () => {
        const input = [
            `import { StreamableHTTPServerTransport as T, EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics.some(d => d.message.includes('mixes symbols') && d.message.includes('Split'))).toBe(true);
    });

    it('emits warning for re-export mixing symbols from different v2 packages', () => {
        const input = `export { StreamableHTTPServerTransport, EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.some(d => d.message.includes('mixes symbols') && d.message.includes('Split'))).toBe(true);
    });

    it('returns usedPackages on early return when only re-exports exist', () => {
        const input = `export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.usedPackages).toBeDefined();
        expect(result.usedPackages!.has('@modelcontextprotocol/server')).toBe(true);
    });

    it('emits warning for re-exported IsomorphicHeaders', () => {
        const input = `export { IsomorphicHeaders } from '@modelcontextprotocol/sdk/types.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('IsomorphicHeaders');
        expect(result.diagnostics[0]!.message).toContain('removed');
    });

    it('handles unknown auth subpath via catch-all', () => {
        const input = `import { SomeType } from '@modelcontextprotocol/sdk/server/auth/handler.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.changesCount).toBe(1);
        expect(sourceFile.getFullText()).not.toContain('@modelcontextprotocol/sdk');
        expect(result.diagnostics.some(d => d.message.includes('Server auth removed'))).toBe(true);
    });

    it('rewrites InMemoryTransport to @modelcontextprotocol/server for server projects', () => {
        const input = `import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';\n`;
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain(`from "@modelcontextprotocol/server"`);
        expect(result).toContain('InMemoryTransport');
        expect(result).not.toContain('@modelcontextprotocol/sdk');
    });

    it('rewrites InMemoryTransport to @modelcontextprotocol/client for client projects', () => {
        const input = `import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';\n`;
        const result = applyTransform(input, { projectType: 'client' });
        expect(result).toContain(`from "@modelcontextprotocol/client"`);
        expect(result).toContain('InMemoryTransport');
        expect(result).not.toContain('@modelcontextprotocol/sdk');
    });

    it('resolves InMemoryTransport based on sibling client imports', () => {
        const input = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'both' });
        expect(result).toContain(`from "@modelcontextprotocol/client"`);
        expect(result).toContain('InMemoryTransport');
    });
});
