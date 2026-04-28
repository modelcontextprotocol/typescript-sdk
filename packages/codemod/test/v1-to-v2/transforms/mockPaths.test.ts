import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { mockPathsTransform } from '../../../src/migrations/v1-to-v2/transforms/mockPaths.js';
import type { TransformContext } from '../../../src/types.js';

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
    });

    describe('vi.mock', () => {
        it('rewrites SDK path in vi.mock', () => {
            const input = [`vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({`, `    McpServer: vi.fn()`, `}));`, ''].join('\n');
            const result = applyTransform(input);
            expect(result).toContain(`'@modelcontextprotocol/server'`);
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

        it('emits warning for removed SDK dynamic import path', () => {
            const input = [`const m = await import('@modelcontextprotocol/sdk/server/sse.js');`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.diagnostics.length).toBeGreaterThan(0);
            expect(result.diagnostics[0]!.message).toContain('SSE server transport removed in v2');
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
});
