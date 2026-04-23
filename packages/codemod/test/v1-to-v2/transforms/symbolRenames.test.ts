import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { symbolRenamesTransform } from '../../../src/migrations/v1-to-v2/transforms/symbolRenames.js';
import type { TransformContext } from '../../../src/types.js';

const ctx: TransformContext = { projectType: 'server' };

function applyTransform(code: string): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    symbolRenamesTransform.apply(sourceFile, ctx);
    return sourceFile.getFullText();
}

describe('symbol-renames transform', () => {
    it('renames McpError to ProtocolError', () => {
        const input = [`import { McpError } from '@modelcontextprotocol/sdk/types.js';`, `throw new McpError(1, 'error');`, ''].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ProtocolError');
        expect(result).not.toContain('McpError');
    });

    it('renames JSONRPCError to JSONRPCErrorResponse', () => {
        const input = [`import { JSONRPCError } from '@modelcontextprotocol/sdk/types.js';`, `const e: JSONRPCError = error;`, ''].join(
            '\n'
        );
        const result = applyTransform(input);
        expect(result).toContain('JSONRPCErrorResponse');
        expect(result).not.toMatch(/\bJSONRPCError\b/);
    });

    it('renames isJSONRPCError to isJSONRPCErrorResponse', () => {
        const input = [`import { isJSONRPCError } from '@modelcontextprotocol/sdk/types.js';`, `if (isJSONRPCError(x)) {}`, ''].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('isJSONRPCErrorResponse');
    });

    it('renames isJSONRPCResponse to isJSONRPCResultResponse', () => {
        const input = [`import { isJSONRPCResponse } from '@modelcontextprotocol/sdk/types.js';`, `if (isJSONRPCResponse(x)) {}`, ''].join(
            '\n'
        );
        const result = applyTransform(input);
        expect(result).toContain('isJSONRPCResultResponse');
    });

    it('renames ResourceReference to ResourceTemplateReference', () => {
        const input = [
            `import { ResourceReference } from '@modelcontextprotocol/sdk/types.js';`,
            `const ref: ResourceReference = { type: 'ref', uri: '' };`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ResourceTemplateReference');
        expect(result).not.toMatch(/\bResourceReference\b/);
    });

    it('splits ErrorCode into ProtocolErrorCode and SdkErrorCode', () => {
        const input = [
            `import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `const a = ErrorCode.InvalidParams;`,
            `const b = ErrorCode.RequestTimeout;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ProtocolErrorCode.InvalidParams');
        expect(result).toContain('SdkErrorCode.RequestTimeout');
        expect(result).not.toMatch(/\bErrorCode\./);
        expect(result).not.toMatch(/import.*\bErrorCode\b/);
    });

    it('handles ErrorCode with only SDK members', () => {
        const input = [`import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';`, `const a = ErrorCode.ConnectionClosed;`, ''].join(
            '\n'
        );
        const result = applyTransform(input);
        expect(result).toContain('SdkErrorCode.ConnectionClosed');
        expect(result).toContain('SdkErrorCode');
        expect(result).not.toContain('ProtocolErrorCode');
    });

    it('does not rename property keys that match renamed symbols', () => {
        const input = [
            `import { McpError } from '@modelcontextprotocol/sdk/types.js';`,
            `const config = { McpError: 'some value' };`,
            `throw new McpError(1, 'error');`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("{ McpError: 'some value' }");
        expect(result).toContain('new ProtocolError');
    });

    it('does not rename property access names that match renamed symbols', () => {
        const input = [
            `import { McpError } from '@modelcontextprotocol/sdk/types.js';`,
            `const x = config.McpError;`,
            `throw new McpError(1, 'error');`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('config.McpError');
        expect(result).toContain('new ProtocolError');
    });

    it('is idempotent', () => {
        const input = [`import { McpError } from '@modelcontextprotocol/sdk/types.js';`, `throw new McpError(1, 'error');`, ''].join('\n');
        const first = applyTransform(input);
        const second = applyTransform(first);
        expect(second).toBe(first);
    });

    it('renames RequestHandlerExtra to ServerContext with server generic args', () => {
        const input = [
            `import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            `type MyHandler = (args: any, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => void;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ServerContext');
        expect(result).not.toContain('RequestHandlerExtra');
        expect(result).not.toContain('ServerRequest');
        expect(result).not.toContain('ServerNotification');
    });

    it('renames RequestHandlerExtra to ClientContext with client generic args', () => {
        const input = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            `type MyHandler = (args: any, extra: RequestHandlerExtra<ClientRequest, ClientNotification>) => void;`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        symbolRenamesTransform.apply(sourceFile, { projectType: 'client' });
        const result = sourceFile.getFullText();
        expect(result).toContain('ClientContext');
        expect(result).not.toContain('RequestHandlerExtra');
    });

    it('strips generic type arguments from RequestHandlerExtra', () => {
        const input = [
            `import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            `const extra = {} as RequestHandlerExtra<ServerRequest, ServerNotification>;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('as ServerContext;');
        expect(result).not.toContain('<ServerRequest');
    });

    it('handles RequestHandlerExtra without generic args', () => {
        const input = [
            `import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            `type Extra = RequestHandlerExtra;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ServerContext');
        expect(result).not.toContain('RequestHandlerExtra');
    });

    it('defaults RequestHandlerExtra to ClientContext for client projects', () => {
        const input = [
            `import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            `type Extra = RequestHandlerExtra;`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        symbolRenamesTransform.apply(sourceFile, { projectType: 'client' });
        const result = sourceFile.getFullText();
        expect(result).toContain('ClientContext');
    });

    it('replaces SchemaInput<T> with StandardSchemaWithJSON.InferInput<T>', () => {
        const input = [
            `import type { SchemaInput } from '@modelcontextprotocol/server';`,
            `type Input = SchemaInput<typeof mySchema>;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('StandardSchemaWithJSON.InferInput<typeof mySchema>');
        expect(result).not.toContain('SchemaInput');
    });

    it('replaces bare SchemaInput with StandardSchemaWithJSON.InferInput<unknown>', () => {
        const input = [`import type { SchemaInput } from '@modelcontextprotocol/server';`, `type Input = SchemaInput;`, ''].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('StandardSchemaWithJSON.InferInput<unknown>');
        expect(result).not.toContain('SchemaInput');
    });

    it('adds StandardSchemaWithJSON type import for SchemaInput migration', () => {
        const input = [
            `import type { SchemaInput } from '@modelcontextprotocol/server';`,
            `type Input = SchemaInput<typeof mySchema>;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('StandardSchemaWithJSON');
        expect(result).toMatch(/import type.*StandardSchemaWithJSON/);
    });

    it('removes SchemaInput import after migration', () => {
        const input = [
            `import type { SchemaInput } from '@modelcontextprotocol/server';`,
            `type Input = SchemaInput<typeof mySchema>;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).not.toMatch(/import.*SchemaInput/);
    });

    it('is idempotent for SchemaInput transform', () => {
        const input = [
            `import type { SchemaInput } from '@modelcontextprotocol/server';`,
            `type Input = SchemaInput<typeof mySchema>;`,
            ''
        ].join('\n');
        const first = applyTransform(input);
        const second = applyTransform(first);
        expect(second).toBe(first);
    });
});
