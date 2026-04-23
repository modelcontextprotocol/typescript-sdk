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
            expect(result).not.toContain(/(?<!Node)StreamableHTTPServerTransport/);
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

        it('emits warning for unknown SDK mock path', () => {
            const input = [`vi.doMock('@modelcontextprotocol/sdk/unknown/path.js', () => ({}));`, ''].join('\n');
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile('test.ts', input);
            const result = mockPathsTransform.apply(sourceFile, ctx);
            expect(result.diagnostics.length).toBeGreaterThan(0);
            expect(result.diagnostics[0]!.message).toContain('Unknown SDK mock path');
        });
    });
});
