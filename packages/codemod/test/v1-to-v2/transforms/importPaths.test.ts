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

    it('moves SSE server import to server-legacy/sse with info diagnostic', () => {
        const input = `import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';\n`;
        const ctx: TransformContext = { projectType: 'server' };
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, ctx);
        const output = sourceFile.getFullText();
        expect(output).toContain('@modelcontextprotocol/server-legacy/sse');
        expect(output).toContain('SSEServerTransport');
        expect(output).not.toContain('@modelcontextprotocol/sdk');
        expect(result.changesCount).toBeGreaterThan(0);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('SSEServerTransport is deprecated');
    });

    it('resolves a sdk/types.js TYPE import based on sibling client imports', () => {
        const input = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'both' });
        expect(result).toContain(`from "@modelcontextprotocol/client"`);
        expect(result).toContain('CallToolResult');
        expect(result).not.toContain('@modelcontextprotocol/sdk-shared');
    });

    it('resolves a sdk/types.js TYPE import based on sibling server imports', () => {
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'both' });
        expect(result).toContain(`from "@modelcontextprotocol/server"`);
        expect(result).toContain('CallToolResult');
    });

    it('routes *Schema imports from sdk/types.js to @modelcontextprotocol/sdk-shared', () => {
        const input = `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';\n`;
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain(`from "@modelcontextprotocol/sdk-shared"`);
        expect(result).toContain('CallToolResultSchema');
        expect(result).not.toContain('@modelcontextprotocol/sdk/types');
    });

    it('routes schemas to sdk-shared regardless of client/server sibling context', () => {
        // The only sibling is a client import, but the schema must still go to sdk-shared.
        const input = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'both' });
        expect(result).toContain(`from "@modelcontextprotocol/sdk-shared"`);
        expect(result).toContain('ListToolsResultSchema');
    });

    it('splits a mixed type + schema import: type resolves by context, schema to sdk-shared', () => {
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `import { CallToolResult, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'both' });
        expect(result).toContain(`from "@modelcontextprotocol/sdk-shared"`);
        expect(result).toContain(`from "@modelcontextprotocol/server"`);
        expect(result).toContain('CallToolResult');
        expect(result).toContain('CallToolResultSchema');
        expect(result).not.toContain('@modelcontextprotocol/sdk/types');
    });

    it('splits an aliased types.js import: schema constant to sdk-shared, aliased type to server', () => {
        // The presence of an alias (`Tool as SDKTool`) must not force the whole import into one package;
        // each symbol still routes to its correct v2 target, with the alias preserved.
        const input = [
            `import { CreateMessageRequestSchema, ClientCapabilities, Tool as SDKTool } from '@modelcontextprotocol/sdk/types.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toMatch(/import\s*\{[^}]*\bCreateMessageRequestSchema\b[^}]*\}\s*from\s*["']@modelcontextprotocol\/sdk-shared["']/);
        expect(result).toMatch(/import\s*\{[^}]*\bClientCapabilities\b[^}]*\}\s*from\s*["']@modelcontextprotocol\/server["']/);
        expect(result).toContain('Tool as SDKTool');
        // the schema constant must NOT end up imported from @modelcontextprotocol/server
        expect(result).not.toMatch(/import\s*\{[^}]*CreateMessageRequestSchema[^}]*\}\s*from\s*["']@modelcontextprotocol\/server["']/);
        expect(result).not.toContain('@modelcontextprotocol/sdk/types');
    });

    it('does not emit a "mixes symbols" diagnostic for an aliased mixed import (it splits instead)', () => {
        const input = `import { CreateMessageRequestSchema, Tool as SDKTool } from '@modelcontextprotocol/sdk/types.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.some(d => d.message.includes('mixes symbols'))).toBe(false);
    });

    it('preserves a leading file-header comment when rewriting the first SDK import', () => {
        const input = [
            `/**`,
            ` * Web-standard transport for MCP.`,
            ` */`,
            `import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';`,
            `import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain('Web-standard transport for MCP.');
        expect(result).toContain('@modelcontextprotocol/server');
        expect(result).not.toContain('@modelcontextprotocol/sdk/');
    });

    it('does not duplicate a multi-block leading header (blank line) when rewriting the first import in place', () => {
        // The first SDK import is a namespace import, so it is rewritten in place (setModuleSpecifier) and
        // its leading comments survive. The header is two // blocks separated by a BLANK line. A `\n`-join
        // of the comment ranges loses that blank line, so the survival check would mis-fire and re-insert
        // the header — duplicating it. The captured text must match the file's bytes exactly.
        const input = [
            `// Copyright ACME`,
            ``,
            `// Notes about the types module`,
            `import * as types from '@modelcontextprotocol/sdk/types.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'server' });
        expect(result.split('// Copyright ACME').length - 1).toBe(1);
        expect(result).toContain('@modelcontextprotocol/server');
    });

    it('does not duplicate a CRLF leading header when rewriting the first import in place', () => {
        // Same in-place rewrite, but the two // header lines are separated by CRLF. A `\n`-join never
        // matches the file's `\r\n`, so the survival check would mis-fire and duplicate the header.
        const input = `// Copyright ACME\r\n// Licensed MIT\r\n\r\nimport * as types from '@modelcontextprotocol/sdk/types.js';\r\n`;
        const result = applyTransform(input, { projectType: 'server' });
        expect(result.split('// Copyright ACME').length - 1).toBe(1);
        expect(result).toContain('@modelcontextprotocol/server');
    });

    it('routes OAuth *Schema from sdk/shared/auth.js to sdk-shared; the TYPE resolves by context', () => {
        // OAuthTokensSchema is a Zod schema re-exported by sdk-shared (AUTH_SCHEMA_NAMES), so route it
        // there — `OAuthTokensSchema.parse(...)` keeps working. OAuthTokens (the type) has no schema-name
        // match and resolves by context to @modelcontextprotocol/client.
        const input = [
            `import { OAuthTokensSchema, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';`,
            `const t = OAuthTokensSchema.parse(raw);`,
            `let x: OAuthTokens;`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'client' });
        expect(result).toMatch(/import\s*\{[^}]*\bOAuthTokensSchema\b[^}]*\}\s*from\s*["']@modelcontextprotocol\/sdk-shared["']/);
        expect(result).toMatch(/import\s*\{[^}]*\bOAuthTokens\b[^}]*\}\s*from\s*["']@modelcontextprotocol\/client["']/);
        expect(result).toContain('OAuthTokensSchema.parse(raw)');
        expect(result).not.toContain('@modelcontextprotocol/sdk/shared/auth');
    });

    it('does not emit a project-type note when every symbol routes to sdk-shared (both project)', () => {
        // A types.js import of nothing but `*Schema` constants routes entirely to sdk-shared, so the
        // context package is never used — resolveTypesPackage must not be called, and no "both"-project
        // info note should be emitted.
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            `import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';\n`
        );
        const result = importPathsTransform.apply(sourceFile, { projectType: 'both' });
        expect(result.diagnostics.some(d => /both client and server|determine project type/i.test(d.message))).toBe(false);
        expect(sourceFile.getFullText()).toContain('@modelcontextprotocol/sdk-shared');
        expect(sourceFile.getFullText()).not.toContain('@modelcontextprotocol/sdk/types');
    });

    it('does not warn about project type when an auth-schema-only import routes entirely to sdk-shared (unknown project)', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            `import { OAuthTokensSchema, OAuthMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';\n`
        );
        const result = importPathsTransform.apply(sourceFile, { projectType: 'unknown' });
        expect(result.diagnostics.some(d => /determine project type/i.test(d.message))).toBe(false);
        expect(sourceFile.getFullText()).toContain('@modelcontextprotocol/sdk-shared');
    });

    it('still warns about project type when a non-schema symbol falls through to context (unknown project)', () => {
        // Control: `Tool` is a type with no schema-name match, so it falls through to context resolution —
        // the warning must still fire (lazy resolution must not suppress genuine fall-throughs).
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            `import { CallToolResultSchema, Tool } from '@modelcontextprotocol/sdk/types.js';\n`
        );
        const result = importPathsTransform.apply(sourceFile, { projectType: 'unknown' });
        expect(result.diagnostics.some(d => /determine project type/i.test(d.message))).toBe(true);
    });

    it('splits a mixed default + named schema import — schema to sdk-shared, default to context', () => {
        // The named `CallToolResultSchema` must route to sdk-shared even though a default import is present;
        // the default binding (which can't be split) moves to the context package. Pre-fix the whole import
        // moved to context and the schema silently became a "no exported member" error.
        const result = applyTransform(`import sdk, { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';\n`, {
            projectType: 'server'
        });
        expect(result).toMatch(/import\s*\{[^}]*\bCallToolResultSchema\b[^}]*\}\s*from\s*["']@modelcontextprotocol\/sdk-shared["']/);
        expect(result).toMatch(/import\s+sdk\s+from\s*["']@modelcontextprotocol\/server["']/);
        expect(result).not.toContain('@modelcontextprotocol/sdk/types');
    });

    it('does not rewrite schema .parse() usages (migrates as an import-path swap)', () => {
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const r = CallToolResultSchema.parse(value);`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain('CallToolResultSchema.parse(value)');
        expect(result).toContain(`from "@modelcontextprotocol/sdk-shared"`);
    });

    it('routes elicitation primitive *Schema TYPE names from sdk/types.js by context, not to sdk-shared', () => {
        // These names END in `Schema` but are TYPES; their Zod constant is `<Name>SchemaSchema`. They
        // must resolve to the context package (where the types live), never to sdk-shared (which only
        // exports the `*SchemaSchema` constants) — otherwise the codemod emits a broken import.
        const elicitationTypeNames = [
            'BooleanSchema',
            'StringSchema',
            'NumberSchema',
            'EnumSchema',
            'SingleSelectEnumSchema',
            'MultiSelectEnumSchema',
            'TitledSingleSelectEnumSchema',
            'UntitledSingleSelectEnumSchema',
            'TitledMultiSelectEnumSchema',
            'UntitledMultiSelectEnumSchema',
            'LegacyTitledEnumSchema'
        ];
        for (const typeName of elicitationTypeNames) {
            const input = `import { ${typeName} } from '@modelcontextprotocol/sdk/types.js';\n`;
            const result = applyTransform(input, { projectType: 'server' });
            expect(result, typeName).toContain(`from "@modelcontextprotocol/server"`);
            expect(result, typeName).not.toContain('@modelcontextprotocol/sdk-shared');
            expect(result, typeName).toContain(typeName);
        }
    });

    it('splits a primitive-schema TYPE from its matching schema CONSTANT (BooleanSchema vs BooleanSchemaSchema)', () => {
        // They differ only by a trailing `Schema`, which the suffix heuristic could not distinguish.
        // The constant goes to sdk-shared; the type resolves by context.
        const input = `import { BooleanSchema, BooleanSchemaSchema } from '@modelcontextprotocol/sdk/types.js';\n`;
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain(`from "@modelcontextprotocol/sdk-shared"`);
        expect(result).toContain('BooleanSchemaSchema');
        expect(result).toContain(`from "@modelcontextprotocol/server"`);
        expect(result).toMatch(/BooleanSchema\b/);
        expect(result).not.toContain('@modelcontextprotocol/sdk/types');
    });

    it('routes a renamed spec schema (JSONRPCErrorSchema) from sdk/types.js to sdk-shared', () => {
        // JSONRPCErrorSchema → JSONRPCErrorResponseSchema, a sdk-shared export. Membership is checked
        // against the rename-resolved name; the symbolRenames transform applies the rename afterward,
        // so importPaths alone leaves the name unchanged but routes it to sdk-shared.
        const input = `import { JSONRPCErrorSchema } from '@modelcontextprotocol/sdk/types.js';\n`;
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain(`from "@modelcontextprotocol/sdk-shared"`);
        expect(result).toContain('JSONRPCErrorSchema');
        expect(result).not.toContain('@modelcontextprotocol/sdk/types');
    });

    it('emits a split diagnostic for a re-export mixing a spec schema and a *Schema type (no silent breakage)', () => {
        // The `*Schema` suffix would have routed BooleanSchema to sdk-shared silently (no such export);
        // membership routing instead surfaces the mismatch so the user splits the re-export manually.
        const input = `export { CallToolResultSchema, BooleanSchema } from '@modelcontextprotocol/sdk/types.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.some(d => d.message.includes('mixes symbols') && d.message.includes('Split'))).toBe(true);
    });

    it('flags *Schema accesses through a namespace import of sdk/types.js (cannot be split)', () => {
        const input = [
            `import * as types from '@modelcontextprotocol/sdk/types.js';`,
            `const r = types.CallToolResultSchema.parse(value);`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        const messages = result.diagnostics.map(d => d.message).join('\n');
        // The namespace can't be split, so the schema can't be auto-routed — but the user must be told.
        expect(messages).toContain('@modelcontextprotocol/sdk-shared');
        expect(messages).toContain('CallToolResultSchema');
        // The namespace import itself still moves to the context package (its types live there).
        // (setModuleSpecifier preserves the original quote style, so match quote-agnostically.)
        expect(sourceFile.getFullText()).toContain('@modelcontextprotocol/server');
    });

    it('suggests the v2 (rename-resolved) name in the namespace schema-access diagnostic', () => {
        // JSONRPCErrorSchema is re-exported by sdk-shared as JSONRPCErrorResponseSchema; the suggested
        // import must use the v2 name (the v1 name has no exported member), and mention the rename.
        const input = [
            `import * as types from '@modelcontextprotocol/sdk/types.js';`,
            `const r = types.JSONRPCErrorSchema.safeParse(value);`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        const msg = result.diagnostics.map(d => d.message).join('\n');
        expect(msg).toContain("import { JSONRPCErrorResponseSchema } from '@modelcontextprotocol/sdk-shared'");
        expect(msg).toContain('JSONRPCErrorSchema → JSONRPCErrorResponseSchema');
        expect(msg).not.toContain('import { JSONRPCErrorSchema } from');
    });

    it('does not flag a namespace import of sdk/types.js that only accesses types', () => {
        const input = [`import * as types from '@modelcontextprotocol/sdk/types.js';`, `const t: types.CallToolResult = value;`, ''].join(
            '\n'
        );
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.diagnostics.map(d => d.message).join('\n')).not.toContain('@modelcontextprotocol/sdk-shared');
    });

    it('resolves extensionless sdk/types (no .js suffix) the same as sdk/types.js', () => {
        const input = `import { CallToolResult } from '@modelcontextprotocol/sdk/types';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        const output = sourceFile.getFullText();
        expect(output).toContain(`from "@modelcontextprotocol/server"`);
        expect(output).toContain('CallToolResult');
        expect(output).not.toContain('@modelcontextprotocol/sdk');
        expect(result.diagnostics.map(d => d.message).join('\n')).not.toContain('Unknown SDK import path');
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

    it('moves auth router import to server-legacy/auth with info diagnostic', () => {
        const input = `import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        const output = sourceFile.getFullText();
        expect(output).toContain('@modelcontextprotocol/server-legacy/auth');
        expect(output).toContain('mcpAuthRouter');
        expect(output).not.toContain('@modelcontextprotocol/sdk');
        expect(result.changesCount).toBeGreaterThan(0);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('Legacy OAuth AS router');
    });

    it('moves auth provider import to server-legacy/auth', () => {
        const input = `import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';\n`;
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain('@modelcontextprotocol/server-legacy/auth');
        expect(result).toContain('OAuthServerProvider');
        expect(result).not.toContain('@modelcontextprotocol/sdk');
    });

    it('moves auth middleware import to server-legacy/auth', () => {
        const input = `import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware.js';\n`;
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain('@modelcontextprotocol/server-legacy/auth');
        expect(result).toContain('requireBearerAuth');
        expect(result).not.toContain('@modelcontextprotocol/sdk');
    });

    it('moves auth errors import to server-legacy/auth', () => {
        const input = `import { InvalidTokenError, OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';\n`;
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain('@modelcontextprotocol/server-legacy/auth');
        expect(result).toContain('InvalidTokenError');
        expect(result).toContain('OAuthError');
        expect(result).not.toContain('@modelcontextprotocol/sdk');
    });

    it('consolidates multiple auth subpath imports into single server-legacy/auth import', () => {
        const input = [
            `import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';`,
            `import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware.js';`,
            ''
        ].join('\n');
        const result = applyTransform(input, { projectType: 'server' });
        expect(result).toContain('mcpAuthRouter');
        expect(result).toContain('requireBearerAuth');
        expect(result).toContain('@modelcontextprotocol/server-legacy/auth');
        const importLines = result.split('\n').filter((l: string) => l.includes('@modelcontextprotocol/server-legacy/auth'));
        expect(importLines.length).toBe(1);
    });

    it('moves SSE server re-export to server-legacy/sse', () => {
        const input = `export { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        const output = sourceFile.getFullText();
        expect(output).toContain('@modelcontextprotocol/server-legacy/sse');
        expect(output).toContain('SSEServerTransport');
        expect(result.diagnostics.some(d => d.message.includes('SSEServerTransport is deprecated'))).toBe(true);
    });

    it('resolves extensionless sdk/types re-export (no .js suffix)', () => {
        const input = `export { CallToolResult } from '@modelcontextprotocol/sdk/types';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        const output = sourceFile.getFullText();
        expect(output).toContain('@modelcontextprotocol/server');
        expect(output).not.toContain('@modelcontextprotocol/sdk');
        expect(result.diagnostics.map(d => d.message).join('\n')).not.toContain('Unknown SDK export path');
    });

    it('includes server-legacy in usedPackages for SSE import', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            `import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';\n`
        );
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.usedPackages).toBeDefined();
        expect(result.usedPackages!.has('@modelcontextprotocol/server-legacy/sse')).toBe(true);
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

    it('splits an aliased import mixing symbols from different v2 packages (no longer bails)', () => {
        const input = [
            `import { StreamableHTTPServerTransport as T, EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        const output = sourceFile.getFullText();
        // transport (aliased + renamed) → /node; companion type → /server
        expect(output).toContain('NodeStreamableHTTPServerTransport as T');
        expect(output).toContain('@modelcontextprotocol/node');
        expect(output).toMatch(/import\s*\{[^}]*\bEventStore\b[^}]*\}\s*from\s*["']@modelcontextprotocol\/server["']/);
        expect(output).not.toContain('@modelcontextprotocol/sdk');
        expect(result.diagnostics.some(d => d.message.includes('mixes symbols'))).toBe(false);
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

    it('moves unknown auth subpath to server-legacy/auth via catch-all', () => {
        const input = `import { SomeType } from '@modelcontextprotocol/sdk/server/auth/handler.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(result.changesCount).toBe(1);
        const output = sourceFile.getFullText();
        expect(output).toContain('@modelcontextprotocol/server-legacy/auth');
        expect(output).toContain('SomeType');
        expect(output).not.toContain('@modelcontextprotocol/sdk');
        expect(result.diagnostics.some(d => d.message.includes('Legacy auth module'))).toBe(true);
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

    it('includes subpath target in usedPackages for stdio-only file', () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            'test.ts',
            `import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';\n`
        );
        const result = importPathsTransform.apply(sourceFile, { projectType: 'client' });
        expect(result.usedPackages).toBeDefined();
        expect(result.usedPackages!.has('@modelcontextprotocol/client/stdio')).toBe(true);
    });

    it('removes zod-compat import with warning', () => {
        const input = `import { AnySchema, SchemaOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js';\n`;
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        expect(sourceFile.getFullText()).not.toContain('AnySchema');
        expect(sourceFile.getFullText()).not.toContain('@modelcontextprotocol/sdk');
        expect(result.changesCount).toBeGreaterThan(0);
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.diagnostics[0]!.message).toContain('zod-compat');
    });

    it('renames ResourceTemplate to ResourceTemplateType in types.js imports', () => {
        const input = [
            `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
            `import { ResourceTemplate } from '@modelcontextprotocol/sdk/types.js';`,
            `const t: ResourceTemplate = getTemplate();`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = importPathsTransform.apply(sourceFile, { projectType: 'server' });
        const output = sourceFile.getFullText();
        expect(result.changesCount).toBeGreaterThan(0);
        expect(output).toContain('ResourceTemplateType');
        expect(output).not.toMatch(/(?<!ResourceTemplate)(?<![a-zA-Z])ResourceTemplate(?!Type)(?![a-zA-Z])/);
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

    describe('validator subpath rewrites', () => {
        it('rewrites CfWorkerJsonSchemaValidator from v1 cfworker-provider to client subpath', () => {
            const input = [
                `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
                `import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';`,
                ''
            ].join('\n');
            const result = applyTransform(input, { projectType: 'client' });
            expect(result).toContain(`from "@modelcontextprotocol/client/validators/cf-worker"`);
            expect(result).toContain('CfWorkerJsonSchemaValidator');
            expect(result).not.toContain('@modelcontextprotocol/sdk');
        });

        it('rewrites CfWorkerJsonSchemaValidator from v1 cfworker short alias to server subpath', () => {
            const input = [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';`,
                ''
            ].join('\n');
            const result = applyTransform(input, { projectType: 'server' });
            expect(result).toContain(`from "@modelcontextprotocol/server/validators/cf-worker"`);
            expect(result).toContain('CfWorkerJsonSchemaValidator');
        });

        it('rewrites AjvJsonSchemaValidator from v1 ajv-provider to server subpath', () => {
            const input = [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';`,
                ''
            ].join('\n');
            const result = applyTransform(input, { projectType: 'server' });
            expect(result).toContain(`from "@modelcontextprotocol/server/validators/ajv"`);
            expect(result).toContain('AjvJsonSchemaValidator');
        });

        it('rewrites AjvJsonSchemaValidator from v1 ajv short alias to server subpath', () => {
            const input = [
                `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';`,
                `import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';`,
                ''
            ].join('\n');
            const result = applyTransform(input, { projectType: 'server' });
            expect(result).toContain(`from "@modelcontextprotocol/server/validators/ajv"`);
            expect(result).toContain('AjvJsonSchemaValidator');
        });

        it('routes validator subpath to client when only client siblings exist', () => {
            const input = [
                `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
                `import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';`,
                ''
            ].join('\n');
            const result = applyTransform(input, { projectType: 'both' });
            expect(result).toContain(`from "@modelcontextprotocol/client/validators/ajv"`);
        });

        it('routes validator subpath via project type when no SDK siblings', () => {
            const input = `import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';\n`;
            const result = applyTransform(input, { projectType: 'server' });
            expect(result).toContain(`from "@modelcontextprotocol/server/validators/cf-worker"`);
        });

        it('includes the validator subpath in usedPackages', () => {
            const project = new Project({ useInMemoryFileSystem: true });
            const sourceFile = project.createSourceFile(
                'test.ts',
                `import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';\n`
            );
            const result = importPathsTransform.apply(sourceFile, { projectType: 'client' });
            expect(result.usedPackages).toBeDefined();
            expect(result.usedPackages!.has('@modelcontextprotocol/client/validators/cf-worker')).toBe(true);
        });

        it('rewrites the validation/index type-only import to the resolved base package', () => {
            const input = `import type { jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/index.js';\n`;
            const result = applyTransform(input, { projectType: 'server' });
            expect(result).toContain(`from "@modelcontextprotocol/server"`);
            expect(result).toContain('jsonSchemaValidator');
        });
    });
});
