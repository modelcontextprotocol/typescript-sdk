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

    it('imports both ServerContext and ClientContext when file has both generic arg types', () => {
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            `type S = RequestHandlerExtra<ServerRequest, ServerNotification>;`,
            `type C = RequestHandlerExtra<ClientRequest, ClientNotification>;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('type S = ServerContext;');
        expect(result).toContain('type C = ClientContext;');
        expect(result).toMatch(/import.*ServerContext/);
        expect(result).toMatch(/import.*ClientContext/);
        expect(result).not.toContain('RequestHandlerExtra');
    });

    it('does not rename symbols from non-MCP imports', () => {
        const input = [
            `import { ErrorCode } from '@grpc/grpc-js';`,
            `import { ResourceReference } from '@google-cloud/asset';`,
            `if (err.code === ErrorCode.NOT_FOUND) {}`,
            `const ref: ResourceReference = {};`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ErrorCode.NOT_FOUND');
        expect(result).toContain('ResourceReference');
        expect(result).not.toContain('ProtocolErrorCode');
        expect(result).not.toContain('SdkErrorCode');
        expect(result).not.toContain('ResourceTemplateReference');
    });

    it('does not split ErrorCode from non-MCP imports', () => {
        const input = [
            `import { ErrorCode } from '@grpc/grpc-js';`,
            `const a = ErrorCode.NOT_FOUND;`,
            `const b = ErrorCode.CANCELLED;`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = symbolRenamesTransform.apply(sourceFile, ctx);
        expect(result.changesCount).toBe(0);
        expect(sourceFile.getFullText()).toContain('ErrorCode.NOT_FOUND');
        expect(sourceFile.getFullText()).toContain('ErrorCode.CANCELLED');
    });

    it('does not rename RequestHandlerExtra from non-MCP imports', () => {
        const input = [
            `import type { RequestHandlerExtra } from './my-local-types.js';`,
            `type MyHandler = (extra: RequestHandlerExtra) => void;`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = symbolRenamesTransform.apply(sourceFile, ctx);
        expect(result.changesCount).toBe(0);
        expect(sourceFile.getFullText()).toContain('RequestHandlerExtra');
        expect(sourceFile.getFullText()).not.toContain('ServerContext');
    });

    it('cleans up empty import declaration after ErrorCode split', () => {
        const input = [`import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';`, `const a = ErrorCode.InvalidParams;`, ''].join(
            '\n'
        );
        const result = applyTransform(input);
        expect(result).not.toMatch(/import\s*\{\s*\}/);
    });

    it('cleans up empty import declaration after RequestHandlerExtra removal', () => {
        const input = [
            `import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            `type Extra = RequestHandlerExtra;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).not.toMatch(/import\s+type\s*\{\s*\}/);
        expect(result).not.toContain('@modelcontextprotocol/sdk/shared/protocol.js');
    });

    it('preserves shorthand property keys when renaming', () => {
        const input = [
            `import { McpError } from '@modelcontextprotocol/sdk/types.js';`,
            `const errors = { McpError };`,
            `throw new McpError(1, 'error');`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('McpError: ProtocolError');
        expect(result).toContain('new ProtocolError');
    });

    it('preserves export specifier public name with alias', () => {
        const input = [`import { McpError } from '@modelcontextprotocol/sdk/types.js';`, `export { McpError };`, ''].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('export { ProtocolError as McpError }');
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

    it('handles aliased ErrorCode import', () => {
        const input = [
            `import { ErrorCode as EC } from '@modelcontextprotocol/server';`,
            `const a = EC.InvalidParams;`,
            `const b = EC.RequestTimeout;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ProtocolErrorCode.InvalidParams');
        expect(result).toContain('SdkErrorCode.RequestTimeout');
        expect(result).not.toMatch(/\bEC\./);
    });

    it('handles aliased RequestHandlerExtra import', () => {
        const input = [
            `import type { RequestHandlerExtra as RHE } from '@modelcontextprotocol/server';`,
            `type MyHandler = (extra: RHE) => void;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ServerContext');
        expect(result).not.toMatch(/\bRHE\b/);
    });

    it('handles aliased SchemaInput import', () => {
        const input = [
            `import type { SchemaInput as SI } from '@modelcontextprotocol/server';`,
            `type Input = SI<typeof mySchema>;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('StandardSchemaWithJSON.InferInput<typeof mySchema>');
        expect(result).not.toMatch(/\bSI\b/);
    });

    it('does not rename method signature names that match renamed symbols', () => {
        const input = [
            `import { McpError } from '@modelcontextprotocol/server';`,
            `interface ErrorHandler { McpError(): void; }`,
            `throw new McpError('test');`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('interface ErrorHandler { McpError(): void; }');
        expect(result).toContain('new ProtocolError(');
    });

    it('does not rename enum member names that match renamed symbols', () => {
        const input = [
            `import { McpError } from '@modelcontextprotocol/server';`,
            `enum Errors { McpError = 1 }`,
            `throw new McpError('test');`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('enum Errors { McpError = 1 }');
        expect(result).toContain('new ProtocolError(');
    });

    it('does not rename destructuring property names that match renamed symbols', () => {
        const input = [
            `import { McpError } from '@modelcontextprotocol/server';`,
            `const { McpError: localErr } = someObject;`,
            `throw new McpError('test');`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('{ McpError: localErr }');
        expect(result).toContain('new ProtocolError(');
    });

    it('does not corrupt export specifier alias when renaming', () => {
        const input = [`import { McpError } from '@modelcontextprotocol/sdk/types.js';`, `export { McpError as MyCustomError };`, ''].join(
            '\n'
        );
        const result = applyTransform(input);
        expect(result).toContain('export { ProtocolError as MyCustomError }');
        expect(result).not.toContain('export { ProtocolError as ProtocolError }');
    });

    it('does not overwrite local binding in aliased export specifier', () => {
        const input = [
            `import { McpError } from '@modelcontextprotocol/sdk/types.js';`,
            `const Foo = McpError;`,
            `export { Foo as McpError };`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('const Foo = ProtocolError');
        expect(result).toContain('export { Foo as McpError }');
    });
});
