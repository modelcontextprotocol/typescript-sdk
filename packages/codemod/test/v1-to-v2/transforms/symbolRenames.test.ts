import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { symbolRenamesTransform } from '../../../src/migrations/v1-to-v2/transforms/symbolRenames';
import type { TransformContext } from '../../../src/types';

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

    it('renames JSONRPCResponseSchema to JSONRPCResultResponseSchema (result-only in v1)', () => {
        // v1's JSONRPCResponseSchema validated only result responses; v2 reuses the name for a union that
        // also accepts errors. Rename to the result-only schema to preserve v1 parse/safeParse behavior.
        const input = [
            `import { JSONRPCResponseSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const r = JSONRPCResponseSchema.parse(value);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('JSONRPCResultResponseSchema.parse(value)');
        expect(result).not.toMatch(/(?<!Result)JSONRPCResponseSchema/);
    });

    it('renames JSONRPCResponse type to JSONRPCResultResponse (result-only in v1)', () => {
        // v1's JSONRPCResponse type was the result-only response; v2 reuses the name for a
        // result|error union (Infer<typeof JSONRPCResponseSchema>). Leaving the type unrenamed would
        // silently widen a migrated v1 type import — mirror the schema/guard renames.
        const input = [
            `import type { JSONRPCResponse } from '@modelcontextprotocol/server';`,
            `function handle(r: JSONRPCResponse) { return r; }`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('import type { JSONRPCResultResponse }');
        expect(result).toContain('r: JSONRPCResultResponse');
        expect(result).not.toMatch(/(?<!Result)JSONRPCResponse(?!Schema)/);
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

    it('removes dead ServerRequest/ServerNotification imports after RequestHandlerExtra rename', () => {
        const input = [
            `import type { RequestHandlerExtra, ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            `type MyHandler = (args: any, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => void;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ServerContext');
        expect(result).not.toContain('RequestHandlerExtra');
        expect(result).not.toMatch(/import.*ServerRequest/);
        expect(result).not.toMatch(/import.*ServerNotification/);
    });

    it('removes dead ClientRequest/ClientNotification imports after RequestHandlerExtra rename', () => {
        const input = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `import type { RequestHandlerExtra, ClientRequest, ClientNotification } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            `type MyHandler = (args: any, extra: RequestHandlerExtra<ClientRequest, ClientNotification>) => void;`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        symbolRenamesTransform.apply(sourceFile, { projectType: 'client' });
        const result = sourceFile.getFullText();
        expect(result).toContain('ClientContext');
        expect(result).not.toMatch(/import.*ClientRequest/);
        expect(result).not.toMatch(/import.*ClientNotification/);
    });

    it('preserves generic arg imports that are still referenced elsewhere', () => {
        const input = [
            `import type { RequestHandlerExtra, ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/shared/protocol.js';`,
            `type MyHandler = (args: any, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => void;`,
            `type Req = ServerRequest;`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('ServerContext');
        expect(result).not.toMatch(/import.*ServerNotification/);
        expect(result).toMatch(/import.*ServerRequest/);
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
            `import type { RequestHandlerExtra } from './my-local-types';`,
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

    it('prefers non-type-only import when choosing ErrorCode split target module', () => {
        const input = [
            `import type { ServerContext } from '@modelcontextprotocol/server';`,
            `import { Client } from '@modelcontextprotocol/client';`,
            `import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `if (err.code === ErrorCode.InvalidParams) {}`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain(`from '@modelcontextprotocol/client'`);
        expect(result).toContain('ProtocolErrorCode');
        const clientImportLine = result.split('\n').find(l => l.includes('@modelcontextprotocol/client') && !l.includes('import type'));
        expect(clientImportLine).toContain('ProtocolErrorCode');
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

describe('ErrorCode split — instanceof pairing (B2)', () => {
    function applyWithDiagnostics(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = symbolRenamesTransform.apply(sourceFile, { projectType: 'server' });
        return { text: sourceFile.getFullText(), result };
    }

    it('rewrites the paired instanceof class to SdkError and imports it', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) retry();`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain('instanceof SdkError');
        expect(text).toContain('SdkErrorCode.RequestTimeout');
        expect(text).toMatch(/import \{[^}]*SdkError[^}]*\}/);
    });

    it('stays silent for an SdkErrorCode comparison with no instanceof guard', () => {
        const code = [
            `import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `if (e.code === ErrorCode.ConnectionClosed) reconnect();`,
            ''
        ].join('\n');
        const { text, result } = applyWithDiagnostics(code);
        expect(text).toContain('SdkErrorCode.ConnectionClosed');
        expect(result.diagnostics.some(d => d.insertComment)).toBe(false);
    });

    it('stays silent for switch cases over SDK members', () => {
        const code = [
            `import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `switch (e.code) { case ErrorCode.RequestTimeout: retry(); }`,
            ''
        ].join('\n');
        const { text, result } = applyWithDiagnostics(code);
        expect(text).toContain('case SdkErrorCode.RequestTimeout');
        expect(result.diagnostics.some(d => d.insertComment)).toBe(false);
    });

    it('marks a mixed SDK/protocol guard instead of rewriting it', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `if (e instanceof McpError && (e.code === ErrorCode.ConnectionClosed || e.code === ErrorCode.ParseError)) handle();`,
            ''
        ].join('\n');
        const { text, result } = applyWithDiagnostics(code);
        expect(text).not.toContain('instanceof SdkError');
        expect(text).toContain('SdkErrorCode.ConnectionClosed');
        expect(text).toContain('ProtocolErrorCode.ParseError');
        const diag = result.diagnostics.find(d => d.insertComment);
        expect(diag?.message).toContain('Split the check');
    });

    it('does not claim guards stored through assignments', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `const isProto = e instanceof McpError;`,
            `if (e.code === ErrorCode.RequestTimeout) retry();`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).not.toContain('instanceof SdkError');
    });

    it('rewrites the guard of an all-SDK two-member condition without markers', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `if (e instanceof McpError && (e.code === ErrorCode.RequestTimeout || e.code === ErrorCode.ConnectionClosed)) retry();`,
            ''
        ].join('\n');
        const { text, result } = applyWithDiagnostics(code);
        expect(text).toContain('instanceof SdkError');
        expect(text).not.toContain('instanceof McpError');
        expect(result.diagnostics.some(d => d.insertComment)).toBe(false);
    });

    it('stays silent for bare member uses outside comparisons', () => {
        const code = [`import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';`, `const t = ErrorCode.RequestTimeout;`, ''].join(
            '\n'
        );
        const { result } = applyWithDiagnostics(code);
        expect(result.diagnostics.some(d => d.insertComment)).toBe(false);
    });

    it('leaves ProtocolError untouched for ProtocolErrorCode members', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `if (e instanceof McpError && e.code === ErrorCode.InvalidParams) reject();`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain('ProtocolErrorCode.InvalidParams');
        expect(text).not.toContain('instanceof SdkError');
    });
});

describe('matcher and constructor pairing (B3)', () => {
    function applyWithDiagnostics(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = symbolRenamesTransform.apply(sourceFile, { projectType: 'server' });
        return { text: sourceFile.getFullText(), result };
    }

    it('rewrites a toBeInstanceOf paired with an SDK-code matcher on the same subject', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `it('times out', () => {`,
            `    expect(err).toBeInstanceOf(McpError);`,
            `    expect(err.code).toBe(ErrorCode.RequestTimeout);`,
            `});`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain('toBeInstanceOf(SdkError)');
        expect(text).toContain('SdkErrorCode.RequestTimeout');
        expect(text).toMatch(/import \{[^}]*SdkError[^}]*\}/);
    });

    it('marks a mixed-subject toBeInstanceOf instead of rewriting it', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `it('mixed', () => {`,
            `    expect(err).toBeInstanceOf(McpError);`,
            `    expect(err.code).toBe(ErrorCode.RequestTimeout);`,
            `    expect(err.code).toBe(ErrorCode.ParseError);`,
            `});`,
            ''
        ].join('\n');
        const { text, result } = applyWithDiagnostics(code);
        expect(text).not.toContain('toBeInstanceOf(SdkError)');
        expect(result.diagnostics.some(d => d.insertComment && d.message.includes('Split the assertions'))).toBe(true);
    });

    it('does not touch a toBeInstanceOf whose subject has no SDK-code assertion', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `it('proto', () => {`,
            `    expect(other).toBeInstanceOf(McpError);`,
            `    expect(err.code).toBe(ErrorCode.RequestTimeout);`,
            `});`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain('toBeInstanceOf(ProtocolError)');
    });

    it('moves the constructor class with an SDK-routed code argument', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `throw new McpError(ErrorCode.ConnectionClosed, 'closed');`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain('new SdkError(SdkErrorCode.ConnectionClosed');
        expect(text).not.toContain('new ProtocolError');
    });

    it('leaves constructors with protocol codes on ProtocolError', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `throw new McpError(ErrorCode.InvalidParams, 'bad');`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain('new ProtocolError(ProtocolErrorCode.InvalidParams');
    });
});

describe('pairing redesign (B3 review)', () => {
    function applyWithDiagnostics(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = symbolRenamesTransform.apply(sourceFile, { projectType: 'server' });
        return { text: sourceFile.getFullText(), result };
    }

    it('pairs cast subjects: expect((err as any).code)', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `it('t', () => {`,
            `    expect(err).toBeInstanceOf(McpError);`,
            `    expect((err as any).code).toBe(ErrorCode.RequestTimeout);`,
            `});`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain('toBeInstanceOf(SdkError)');
    });

    it('does not pair an assertion about a different property (err.cause)', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `it('t', () => {`,
            `    expect(err.cause).toBeInstanceOf(McpError);`,
            `    expect(err.code).toBe(ErrorCode.RequestTimeout);`,
            `});`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain('toBeInstanceOf(ProtocolError)');
        expect(text).not.toContain('toBeInstanceOf(SdkError)');
    });

    it('marks a constructor whose code argument mixes both enums', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `throw new McpError(isTimeout ? ErrorCode.RequestTimeout : ErrorCode.InvalidRequest, 'm');`,
            ''
        ].join('\n');
        const { text, result } = applyWithDiagnostics(code);
        expect(text).not.toContain('new SdkError');
        expect(result.diagnostics.some(d => d.insertComment && d.message.includes('Split the construction'))).toBe(true);
    });

    it('ignores SDK members outside the constructor first argument', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `throw new McpError(ErrorCode.InvalidRequest, 'x', { hint: ErrorCode.RequestTimeout });`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain('new ProtocolError(ProtocolErrorCode.InvalidRequest');
    });

    it('removes the stranded error-class import after a sole-use constructor rewrite', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `throw new McpError(ErrorCode.ConnectionClosed, 'closed');`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain('new SdkError(');
        expect(text).not.toMatch(/import \{[^}]*ProtocolError\b[^}]*\} from/);
    });

    it('notes unpaired class matchers in files with SDK-routed codes', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `it('t', async () => {`,
            `    await expect(p).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });`,
            `    expect(somethingElse).toBeInstanceOf(McpError);`,
            `});`,
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        expect(result.diagnostics.some(d => d.message.includes('review those assertions'))).toBe(true);
    });
});

describe('ErrorCode passthrough imports (sweep rollup)', () => {
    it('drops an ErrorCode import with no member accesses and marks the remaining use', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [`import { ErrorCode } from '@modelcontextprotocol/server';`, `registerCodes(ErrorCode);`, ''].join('\n')
        );
        const result = symbolRenamesTransform.apply(sourceFile, { projectType: 'server' });
        const text = sourceFile.getFullText();
        expect(text).not.toContain('import { ErrorCode }');
        const diag = result.diagnostics.find(d => d.insertComment);
        expect(diag?.message).toContain('ProtocolErrorCode');
        expect(diag?.message).toContain('SdkErrorCode');
    });

    it('leaves a still-v1 ErrorCode import alone in isolated runs', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            [
                `import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
                `export function f(code: ErrorCode): boolean { return retryable(code); }`,
                ''
            ].join('\n')
        );
        const result = symbolRenamesTransform.apply(sourceFile, { projectType: 'server' });
        expect(sourceFile.getFullText()).toContain(`from '@modelcontextprotocol/sdk/types.js'`);
        expect(result.diagnostics.some(d => d.message.includes('not exported by the v2 packages'))).toBe(false);
    });
});

describe('cast repointing and dynamic-import bindings (B6)', () => {
    function applyB6(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = symbolRenamesTransform.apply(sourceFile, { projectType: 'server' });
        return { text: sourceFile.getFullText(), result };
    }

    it('re-points stale as-casts when the pairing moves the asserted class', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `it('t', async () => {`,
            `    const err = (await settled) as McpError;`,
            `    expect(err).toBeInstanceOf(McpError);`,
            `    expect(err.code).toBe(ErrorCode.RequestTimeout);`,
            `});`,
            ''
        ].join('\n');
        const { text } = applyB6(code);
        expect(text).toContain('(await settled) as SdkError');
        expect(text).toContain('toBeInstanceOf(SdkError)');
    });

    it('leaves casts alone when the pairing does not move the class', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `it('t', async () => {`,
            `    const err = (await settled) as McpError;`,
            `    expect(err.code).toBe(ErrorCode.InvalidRequest);`,
            `});`,
            ''
        ].join('\n');
        const { text } = applyB6(code);
        expect(text).toContain('as ProtocolError');
    });

    it('renames shorthand dynamic-import destructure bindings and references', () => {
        const code = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `async function load() {`,
            `    const { McpError } = await import('@modelcontextprotocol/sdk/types.js');`,
            `    throw new McpError(1, 'x');`,
            `}`,
            ''
        ].join('\n');
        const { text } = applyB6(code);
        expect(text).toContain('const { ProtocolError }');
        expect(text).toContain('new ProtocolError(1');
    });

    it('re-points only the property name for aliased destructures', () => {
        const code = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `const { McpError: LocalError } = await import('@modelcontextprotocol/sdk/types.js');`,
            `throw new LocalError(1, 'x');`,
            ''
        ].join('\n');
        const { text } = applyB6(code);
        expect(text).toContain('{ ProtocolError: LocalError }');
        expect(text).toContain('new LocalError(1');
    });

    it('ignores destructures of non-SDK dynamic imports', () => {
        const code = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `const { McpError } = await import('./local-errors');`,
            ''
        ].join('\n');
        const { text } = applyB6(code);
        expect(text).toContain(`const { McpError } = await import('./local-errors')`);
    });
});

describe('assignment-cast repointing (B6 review)', () => {
    it('re-points casts assigned in catch blocks when the matcher moves the class', () => {
        const code = [
            `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';`,
            `it('t', async () => {`,
            `    let err: any;`,
            `    try { await op(); } catch (e) { err = e as McpError; }`,
            `    expect(err).toBeInstanceOf(McpError);`,
            `    expect(err.code).toBe(ErrorCode.RequestTimeout);`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        symbolRenamesTransform.apply(sourceFile, { projectType: 'server' });
        const text = sourceFile.getFullText();
        expect(text).toContain('err = e as SdkError');
        expect(text).toContain('toBeInstanceOf(SdkError)');
    });
});

describe('guard polarity in the ErrorCode split (review round 3)', () => {
    function applyR3(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = symbolRenamesTransform.apply(sourceFile, { projectType: 'server' });
        return { text: sourceFile.getFullText(), result };
    }
    const IMP = `import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';\n`;

    it('marks guards joined to the SDK code by a disjunction instead of rewriting', () => {
        const { text, result } = applyR3(IMP + `if (e instanceof McpError || e.code === ErrorCode.RequestTimeout) retry();\n`);
        expect(text).toContain('e instanceof ProtocolError || e.code === SdkErrorCode.RequestTimeout');
        expect(text).not.toContain('SdkError ');
        expect(result.diagnostics.some(d => d.insertComment && d.message.includes('does not pin'))).toBe(true);
    });

    it('rewrites negated guards conjoined with a same-subject SDK code', () => {
        const { text, result } = applyR3(IMP + `if (!(e instanceof McpError) && e.code === ErrorCode.RequestTimeout) bail();\n`);
        expect(text).toContain('!(e instanceof SdkError) && e.code === SdkErrorCode.RequestTimeout');
        expect(result.diagnostics.some(d => d.insertComment)).toBe(false);
    });

    it('rewrites guards conjoined inside a disjunct', () => {
        const { text } = applyR3(IMP + `const retriable = (e instanceof McpError && e.code === ErrorCode.RequestTimeout) || isAbort(e);\n`);
        expect(text).toContain('(e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout)');
    });

    it('marks guards whose conjoined SDK code is on another subject or in a nested function', () => {
        const code =
            IMP +
            `if ((e instanceof McpError && retries.every(r => r.code === ErrorCode.RequestTimeout)) || e.code === ErrorCode.ConnectionClosed) requeue(e);\n`;
        const { text, result } = applyR3(code);
        expect(text).toContain('e instanceof ProtocolError &&');
        expect(text).not.toContain('instanceof SdkError');
        expect(result.diagnostics.some(d => d.insertComment && d.message.includes('does not pin'))).toBe(true);
    });

    it('marks guards conjoined with a negated code comparison', () => {
        const { text, result } = applyR3(IMP + `if (e instanceof McpError && e.code !== ErrorCode.RequestTimeout) propagate(e);\n`);
        expect(text).toContain('e instanceof ProtocolError &&');
        expect(result.diagnostics.some(d => d.insertComment && d.message.includes('does not pin'))).toBe(true);
    });
});
