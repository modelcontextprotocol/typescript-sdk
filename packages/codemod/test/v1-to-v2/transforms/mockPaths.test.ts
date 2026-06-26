import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { mockPathsTransform } from '../../../src/migrations/v1-to-v2/transforms/mockPaths';
import type { TransformContext } from '../../../src/types';

const ctx: TransformContext = { projectType: 'server' };

function applyTransform(code: string, context: TransformContext = ctx): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    mockPathsTransform.apply(sourceFile, context);
    return sourceFile.getFullText();
}

describe('mock-paths transform', () => {
    describe('vi.doMock', () => {
        it('rewrites SDK path in vi.doMock', () => {
            const input = [
                `vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({`,
                `    McpServer: mockMcpServerClass`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server'`);
            expect(result).not.toContain('@modelcontextprotocol/sdk');
        });

        it('renames symbols in vi.doMock factory for streamableHttp', () => {
            const input = [
                `vi.doMock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({`,
                `    StreamableHTTPServerTransport: mockTransport`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/node'`);
            expect(result).toContain('NodeStreamableHTTPServerTransport');
            expect(result).not.toMatch(/(?<!Node)StreamableHTTPServerTransport/);
        });

        it('rewrites webStandardStreamableHttp path', () => {
            const input = [
                `vi.doMock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({`,
                `    WebStandardStreamableHTTPServerTransport: mockTransport`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server'`);
        });

        it('rewrites sdk/types.js path', () => {
            const input = [
                `vi.doMock('@modelcontextprotocol/sdk/types.js', async importOriginal => {`,
                `    const original = await importOriginal();`,
                `    return { ...original, isInitializeRequest: mockFn };`,
                `});`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server'`);
            expect(result).not.toContain('@modelcontextprotocol/sdk');
        });

        it('rewrites extensionless sdk/types path (no .js suffix)', () => {
            const input = [
                `vi.doMock('@modelcontextprotocol/sdk/types', async importOriginal => {`,
                `    const original = await importOriginal();`,
                `    return { ...original, isInitializeRequest: mockFn };`,
                `});`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server'`);
            expect(result).not.toContain('@modelcontextprotocol/sdk');
        });
    });

    describe('vi.mock', () => {
        it('rewrites SDK path in vi.mock', () => {
            const input = [`vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({`, `    McpServer: vi.fn()`, `}));`, ''].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server'`);
        });

        it('rewrites client stdio mock to /stdio subpath', () => {
            const input = [
                `vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({`,
                `    StdioClientTransport: vi.fn()`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/client/stdio'`);
            expect(result).not.toContain('@modelcontextprotocol/sdk');
        });

        it('rewrites server stdio mock to /stdio subpath', () => {
            const input = [
                `vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({`,
                `    StdioServerTransport: vi.fn()`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server/stdio'`);
            expect(result).not.toContain('@modelcontextprotocol/sdk');
        });
    });

    describe('jest.mock', () => {
        it('rewrites SDK path in jest.mock', () => {
            const input = [`jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({`, `    McpServer: jest.fn()`, `}));`, ''].join(
                '\n'
            );
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server'`);
        });

        it('rewrites SDK path in jest.doMock', () => {
            const input = [
                `jest.doMock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({`,
                `    StreamableHTTPServerTransport: jest.fn()`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/node'`);
            expect(result).toContain('NodeStreamableHTTPServerTransport');
        });
    });

    describe('dynamic imports', () => {
        it('rewrites dynamic import path', () => {
            const input = [
                `const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`import('@modelcontextprotocol/node')`);
            expect(result).toContain('NodeStreamableHTTPServerTransport');
        });

        it('preserves local binding when renaming dynamic import destructuring', () => {
            const input = [
                `const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');`,
                `const transport = new StreamableHTTPServerTransport({});`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`import('@modelcontextprotocol/node')`);
            expect(result).toContain('NodeStreamableHTTPServerTransport: StreamableHTTPServerTransport');
            expect(result).toContain('new StreamableHTTPServerTransport({})');
        });

        it('handles aliased dynamic import destructuring', () => {
            const input = [
                `const { StreamableHTTPServerTransport: MyTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');`,
                `const t = new MyTransport({});`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`import('@modelcontextprotocol/node')`);
            expect(result).toContain('NodeStreamableHTTPServerTransport: MyTransport');
            expect(result).toContain('new MyTransport({})');
        });

        it('rewrites dynamic import for server/mcp.js', () => {
            const input = [`const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');`, ''].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`import('@modelcontextprotocol/server')`);
            expect(result).toContain('McpServer');
        });

        it('does not touch non-SDK dynamic imports', () => {
            const input = [`const { something } = await import('some-other-package');`, ''].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`import('some-other-package')`);
        });
    });

    describe('edge cases', () => {
        it('skips non-SDK mock paths', () => {
            const input = [`vi.doMock('some-other-package', () => ({ foo: vi.fn() }));`, ''].join('\n');
            const result = applyTransform(input);
            expect(result).toContain('some-other-package');
        });

        it('is idempotent', () => {
            const input = [`vi.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({`, `    McpServer: mockClass`, `}));`, ''].join(
                '\n'
            );
            const first = applyTransform(input);
            const second = applyTransform(first);
            expect(second).toBe(first);
        });

        it('emits warning for unknown SDK dynamic import path', () => {
            const input = [`const m = await import('@modelcontextprotocol/sdk/unknown/path.js');`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.diagnostics.length).toBeGreaterThan(0);
            expect(result.diagnostics[0]!.message).toContain('Unknown SDK dynamic import path');
        });

        it('rewrites SSE dynamic import to server-legacy/sse', () => {
            const input = [`const m = await import('@modelcontextprotocol/sdk/server/sse.js');`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.changesCount).toBeGreaterThan(0);
            expect(sourceFile.getFullText()).toContain('@modelcontextprotocol/server-legacy/sse');
        });

        it('emits warning for removed SDK dynamic import path', () => {
            const input = [`const m = await import('@modelcontextprotocol/sdk/client/websocket.js');`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.diagnostics.length).toBeGreaterThan(0);
            expect(result.diagnostics[0]!.message).toContain('WebSocketClientTransport removed in v2');
        });

        it('emits warning for unknown SDK mock path', () => {
            const input = [`vi.doMock('@modelcontextprotocol/sdk/unknown/path.js', () => ({}));`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.diagnostics.length).toBeGreaterThan(0);
            expect(result.diagnostics[0]!.message).toContain('Unknown SDK mock path');
        });

        it('does not pick up nested properties for symbolTargetOverrides routing', () => {
            const input = [
                `vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({`,
                `    StreamableHTTPServerTransport: vi.fn().mockImplementation(() => ({`,
                `        handleRequest: vi.fn()`,
                `    }))`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/node'`);
            expect(result).toContain('NodeStreamableHTTPServerTransport');
        });

        it('does not rename nested property keys in mock factory', () => {
            const input = [
                `vi.mock('@modelcontextprotocol/sdk/types.js', () => ({`,
                `    McpError: vi.fn().mockImplementation(() => ({`,
                `        McpError: 'nested prop should not be renamed'`,
                `    }))`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain('ProtocolError:');
            const lines = result.split('\n');
            const nestedLine = lines.find(l => l.includes("'nested prop should not be renamed'"));
            expect(nestedLine).toContain('McpError');
        });

        it('renames SIMPLE_RENAMES symbols in mock factory', () => {
            const input = [
                `vi.mock('@modelcontextprotocol/sdk/types.js', () => ({`,
                `    McpError: vi.fn(),`,
                `    ResourceReference: { type: 'resource' },`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain('@modelcontextprotocol/server');
            expect(result).toContain('ProtocolError');
            expect(result).toContain('ResourceTemplateReference');
            expect(result).not.toMatch(/(?<!Protocol)\bMcpError\b/);
        });

        it('renames SIMPLE_RENAMES symbols in dynamic import destructuring', () => {
            const input = [
                `const { McpError, ResourceReference } = await import('@modelcontextprotocol/sdk/types.js');`,
                `const err = new McpError('fail');`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain('@modelcontextprotocol/server');
            expect(result).toContain('ProtocolError: McpError');
            expect(result).toContain('ResourceTemplateReference: ResourceReference');
            expect(result).toContain('new McpError(');
        });

        it('emits warning for mixed-package mock factory symbols', () => {
            const input = [
                `vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({`,
                `    StreamableHTTPServerTransport: vi.fn(),`,
                `    EventStore: vi.fn()`,
                `}));`,
                ''
            ].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.diagnostics.length).toBeGreaterThan(0);
            expect(result.diagnostics[0]!.message).toContain('mixes symbols that belong to different v2 packages');
        });

        it('does not emit warning for non-destructured dynamic import of module without renamedSymbols', () => {
            const input = [`const mod = await import('@modelcontextprotocol/sdk/server/mcp.js');`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            const renameWarnings = result.diagnostics.filter(d => d.message.includes('Symbol renames'));
            expect(renameWarnings).toHaveLength(0);
        });

        it('emits warning for non-destructured dynamic import of module with renamedSymbols', () => {
            const input = [`const mod = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            const renameWarnings = result.diagnostics.filter(d => d.message.includes('Symbol renames'));
            expect(renameWarnings).toHaveLength(1);
            expect(renameWarnings[0]!.message).toContain('StreamableHTTPServerTransport');
            expect(renameWarnings[0]!.message).not.toContain('McpError');
        });

        it('renames SIMPLE_RENAMES symbols in aliased dynamic import destructuring', () => {
            const input = [
                `const { McpError: MyError } = await import('@modelcontextprotocol/sdk/types.js');`,
                `throw new MyError('fail');`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain('ProtocolError: MyError');
            expect(result).toContain('new MyError(');
        });
    });

    describe('schema constant routing (schemaSymbolTarget)', () => {
        it('routes a vi.mock factory of only spec *Schema constants to core', () => {
            const input = [`vi.mock('@modelcontextprotocol/sdk/types.js', () => ({`, `    CallToolResultSchema: vi.fn()`, `}));`, ''].join(
                '\n'
            );
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/core'`);
            expect(result).not.toContain('@modelcontextprotocol/sdk/types');
            // The schema constant lives in core, never the context (server) package.
            expect(result).not.toContain(`'@modelcontextprotocol/server'`);
        });

        it('routes a vi.mock factory of only auth *Schema constants to core', () => {
            const input = [
                `vi.mock('@modelcontextprotocol/sdk/shared/auth.js', () => ({`,
                `    OAuthTokensSchema: vi.fn()`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/core'`);
            expect(result).not.toContain('@modelcontextprotocol/sdk/shared/auth');
        });

        it('routes a destructured dynamic import of only *Schema constants to core', () => {
            const input = [`const { CallToolResultSchema } = await import('@modelcontextprotocol/sdk/types.js');`, ''].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`import('@modelcontextprotocol/core')`);
            expect(result).not.toContain('@modelcontextprotocol/sdk/types');
        });

        it('renames JSONRPCResponseSchema and routes it to core in a mock factory', () => {
            const input = [`vi.mock('@modelcontextprotocol/sdk/types.js', () => ({`, `    JSONRPCResponseSchema: vi.fn()`, `}));`, ''].join(
                '\n'
            );
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/core'`);
            expect(result).toContain('JSONRPCResultResponseSchema');
            expect(result).not.toMatch(/(?<!Result)JSONRPCResponseSchema/);
        });

        it('flags a vi.mock factory mixing a *Schema constant and a type (cannot be split)', () => {
            const input = [
                `vi.mock('@modelcontextprotocol/sdk/types.js', () => ({`,
                `    CallToolResultSchema: vi.fn(),`,
                `    McpError: vi.fn()`,
                `}));`,
                ''
            ].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.diagnostics.some(d => d.message.includes('mixes symbols that belong to different v2 packages'))).toBe(true);
        });

        it('flags a destructured dynamic import mixing a *Schema constant and a type', () => {
            const input = [`const { CallToolResultSchema, McpError } = await import('@modelcontextprotocol/sdk/types.js');`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.diagnostics.some(d => d.message.includes('belong to different v2 packages'))).toBe(true);
        });

        it('routes a destructured .then() param of only *Schema constants to core', () => {
            const input = [
                `import('@modelcontextprotocol/sdk/types.js').then(({ CallToolResultSchema }) => CallToolResultSchema.parse(value));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`import('@modelcontextprotocol/core')`);
            expect(result).not.toContain('@modelcontextprotocol/sdk/types');
        });

        it('renames a *Schema in a destructured .then() param and routes it to core', () => {
            const input = [
                `import('@modelcontextprotocol/sdk/types.js').then(({ JSONRPCResponseSchema }) => JSONRPCResponseSchema.parse(value));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`import('@modelcontextprotocol/core')`);
            expect(result).toContain('JSONRPCResultResponseSchema');
        });

        it('flags a destructured .then() param mixing a *Schema constant and a type', () => {
            const input = [
                `import('@modelcontextprotocol/sdk/types.js').then(({ CallToolResultSchema, McpError }) => CallToolResultSchema.parse(value));`,
                ''
            ].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.diagnostics.some(d => d.message.includes('belong to different v2 packages'))).toBe(true);
        });
    });

    describe('lazy context resolution (no spurious project-type diagnostic)', () => {
        it('does not warn about project type for a schema-only vi.mock factory (unknown project)', () => {
            // The factory routes entirely to core, so the context package is never used — resolveTypesPackage
            // must not emit a "could not determine project type" warning.
            const input = [`vi.mock('@modelcontextprotocol/sdk/types.js', () => ({`, `    CallToolResultSchema: vi.fn()`, `}));`, ''].join(
                '\n'
            );
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, { projectType: 'unknown' });
            expect(result.diagnostics.some(d => /determine project type/i.test(d.message))).toBe(false);
            expect(sourceFile.getFullText()).toContain('@modelcontextprotocol/core');
        });

        it('does not emit a both-project note for a schema-only destructured dynamic import (both project)', () => {
            const input = [`const { OAuthTokensSchema } = await import('@modelcontextprotocol/sdk/shared/auth.js');`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, { projectType: 'both' });
            expect(result.diagnostics.some(d => /both client and server|determine project type/i.test(d.message))).toBe(false);
            expect(sourceFile.getFullText()).toContain('@modelcontextprotocol/core');
        });

        it('still warns about project type for a non-schema vi.mock factory (unknown project)', () => {
            // Control: isInitializeRequest is a guard (not a schema constant), so the factory falls through to
            // context resolution — the warning must still fire (lazy resolution must not suppress real fall-throughs).
            const input = [`vi.mock('@modelcontextprotocol/sdk/types.js', () => ({`, `    isInitializeRequest: vi.fn()`, `}));`, ''].join(
                '\n'
            );
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, { projectType: 'unknown' });
            expect(result.diagnostics.some(d => /determine project type/i.test(d.message))).toBe(true);
        });
    });

    describe('non-destructured / .then dynamic import schema access (schemaSymbolTarget)', () => {
        it('flags schema access on a non-destructured awaited dynamic import (types.js)', () => {
            const input = [
                `const mod = await import('@modelcontextprotocol/sdk/types.js');`,
                `const r = mod.CallToolResultSchema.parse(value);`,
                ''
            ].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(
                result.diagnostics.some(d => d.message.includes('@modelcontextprotocol/core') && d.message.includes('CallToolResultSchema'))
            ).toBe(true);
        });

        it('flags schema access in a .then() chain (shared/auth.js)', () => {
            const input = [`import('@modelcontextprotocol/sdk/shared/auth.js').then(m => m.OAuthTokensSchema.parse(value));`, ''].join(
                '\n'
            );
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(
                result.diagnostics.some(d => d.message.includes('@modelcontextprotocol/core') && d.message.includes('OAuthTokensSchema'))
            ).toBe(true);
        });

        it('notes the rename for a renamed schema accessed in a .then() chain', () => {
            const input = [`import('@modelcontextprotocol/sdk/types.js').then(m => m.JSONRPCResponseSchema.parse(value));`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(
                result.diagnostics.some(
                    d => d.message.includes('JSONRPCResponseSchema') && d.message.includes('JSONRPCResultResponseSchema')
                )
            ).toBe(true);
        });

        it('does not flag a non-destructured dynamic import with no schema access', () => {
            // Control: `mod` is only used for a guard (not a schema constant), so no schema-moved-to-core note.
            const input = [
                `const mod = await import('@modelcontextprotocol/sdk/types.js');`,
                `const ok = mod.isInitializeRequest(value);`,
                ''
            ].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.diagnostics.some(d => d.message.includes('moved to @modelcontextprotocol/core'))).toBe(false);
        });
    });

    describe('validator subpath rewrites', () => {
        it('rewrites vi.mock of validator provider to the subpath', () => {
            const input = [
                `vi.mock('@modelcontextprotocol/sdk/validation/cfworker-provider.js', () => ({`,
                `    CfWorkerJsonSchemaValidator: vi.fn()`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server/validators/cf-worker'`);
            expect(result).not.toContain('@modelcontextprotocol/sdk');
        });

        it('rewrites vi.doMock of ajv provider with sibling client import', () => {
            const input = [
                `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
                `vi.doMock('@modelcontextprotocol/sdk/validation/ajv-provider.js', () => ({`,
                `    AjvJsonSchemaValidator: vi.fn()`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input, { projectType: 'both' });
            expect(result).toContain(`'@modelcontextprotocol/client/validators/ajv'`);
        });

        it('rewrites dynamic import of validator provider to the subpath', () => {
            const input = [
                `const { AjvJsonSchemaValidator } = await import('@modelcontextprotocol/sdk/validation/ajv-provider.js');`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server/validators/ajv'`);
            expect(result).toContain('AjvJsonSchemaValidator');
        });

        // #122 — type-position dynamic-import qualifiers (`import('…').Name`) are ImportTypeNode, not the
        // CallExpression covered by rewriteDynamicImports. Left untouched they resolve against the removed
        // v1 package and surface as TS2307.
        it("#122 — rewrites a type-position import('…').Name qualifier and routes per-symbol", () => {
            const input = [
                `let meta: import('@modelcontextprotocol/sdk/shared/auth.js').OAuthClientMetadata;`,
                `let schema: import('@modelcontextprotocol/sdk/types.js').CallToolResultSchema;`,
                ''
            ].join('\n');
            const result = applyTransform(input, { projectType: 'client' });
            expect(result).toContain(`import('@modelcontextprotocol/client').OAuthClientMetadata`);
            // Schema constants route to core (per-symbol override), matching the static-import transform.
            expect(result).toContain(`import('@modelcontextprotocol/core').CallToolResultSchema`);
            expect(result).not.toContain('@modelcontextprotocol/sdk');
        });

        // #162 — require()/require.resolve() of a v1 SDK path is not rewritten (the v2 subpath exports
        // have no `require` condition, so a rewrite would still fail at runtime); mark the site instead.
        it('#162 — marks require.resolve() of a v1 SDK path (createRequire and bare require)', () => {
            const input = [
                `import { createRequire } from 'node:module';`,
                `const req = createRequire(import.meta.url);`,
                `const p = req.resolve('@modelcontextprotocol/sdk/server/sse.js');`,
                `const q = require('@modelcontextprotocol/sdk/client/index.js');`,
                ''
            ].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            const markers = result.diagnostics.filter(d => d.insertComment && d.message.includes('require'));
            expect(markers.length).toBe(2);
            // The specifiers are left untouched (not rewritten).
            expect(sourceFile.getFullText()).toContain(`'@modelcontextprotocol/sdk/server/sse.js'`);
        });

        it('rewrites jest.mock of validator short alias to the subpath', () => {
            const input = [
                `jest.mock('@modelcontextprotocol/sdk/validation/cfworker', () => ({`,
                `    CfWorkerJsonSchemaValidator: jest.fn()`,
                `}));`,
                ''
            ].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server/validators/cf-worker'`);
        });
    });
});
