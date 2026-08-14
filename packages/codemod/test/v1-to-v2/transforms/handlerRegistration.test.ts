import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { handlerRegistrationTransform } from '../../../src/migrations/v1-to-v2/transforms/handlerRegistration';
import type { TransformContext } from '../../../src/types';

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
            `import { CallToolRequestSchema } from './local-schemas';`,
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
            `import { CallToolRequestSchema } from './local-schemas';`,
            `import { CallToolRequestSchema as McpSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));`,
            `validateSchema(McpSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("from './local-schemas'");
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

    it('does not modify files with no imports at all', () => {
        const input = [`server.setRequestHandler(SomeSchema, async (req) => ({ content: [] }));`, ''].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('SomeSchema');
        expect(result).not.toContain("'tools/call'");
    });

    it('emits diagnostic for custom method schema (not in spec map)', () => {
        const input = [
            `import { Server } from '@modelcontextprotocol/sdk/server/index.js';`,
            `const AcmeSearch = z.object({ method: z.literal('acme/search'), params: z.object({ query: z.string() }) });`,
            `server.setRequestHandler(AcmeSearch, async (request) => {`,
            `    return { items: [] };`,
            `});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = handlerRegistrationTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.length).toBe(1);
        expect(result.diagnostics[0]!.message).toContain('Custom method handler');
        expect(result.diagnostics[0]!.message).toContain('AcmeSearch');
        expect(result.diagnostics[0]!.message).toContain('3-arg form');
    });

    it('emits diagnostic for custom notification schema', () => {
        const input = [
            `import { Server } from '@modelcontextprotocol/sdk/server/index.js';`,
            `const CustomNotification = z.object({ method: z.literal('acme/notify') });`,
            `server.setNotificationHandler(CustomNotification, async () => {});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = handlerRegistrationTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.length).toBe(1);
        expect(result.diagnostics[0]!.message).toContain('Custom method handler');
        expect(result.diagnostics[0]!.message).toContain('setNotificationHandler');
        expect(result.diagnostics[0]!.message).toContain('CustomNotification');
    });

    it('skips files with no MCP imports', () => {
        const input = [
            `import { EventBus } from 'some-other-library';`,
            `const CustomSchema = z.object({ method: z.literal('custom/op') });`,
            `bus.setRequestHandler(CustomSchema, async (req) => {});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = handlerRegistrationTransform.apply(sourceFile, ctx);
        expect(result.changesCount).toBe(0);
        expect(result.diagnostics.length).toBe(0);
    });

    it('replaces ElicitationCompleteNotificationSchema with method string', () => {
        const input = [
            `import { ElicitationCompleteNotificationSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `client.setNotificationHandler(ElicitationCompleteNotificationSchema, async () => {});`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("setNotificationHandler('notifications/elicitation/complete'");
        expect(result).not.toContain('ElicitationCompleteNotificationSchema');
    });

    it('emits a tasks-removed diagnostic for GetTaskRequestSchema (does NOT rewrite to tasks/get)', () => {
        const input = [
            `import { GetTaskRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(GetTaskRequestSchema, async () => ({}));`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = handlerRegistrationTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).not.toContain("'tasks/get'");
        expect(text).toContain('setRequestHandler(GetTaskRequestSchema');
        expect(result.changesCount).toBe(0);
        expect(result.diagnostics.length).toBe(1);
        expect(result.diagnostics[0]!.message).toContain('Task handler registration');
        expect(result.diagnostics[0]!.message).toContain('SEP-2663');
    });

    it('emits a tasks-removed diagnostic for TaskStatusNotificationSchema (does NOT rewrite)', () => {
        const input = [
            `import { TaskStatusNotificationSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `client.setNotificationHandler(TaskStatusNotificationSchema, async () => {});`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = handlerRegistrationTransform.apply(sourceFile, ctx);
        const text = sourceFile.getFullText();
        expect(text).not.toContain("'notifications/tasks/status'");
        expect(text).toContain('setNotificationHandler(TaskStatusNotificationSchema');
        expect(result.changesCount).toBe(0);
        expect(result.diagnostics.length).toBe(1);
        expect(result.diagnostics[0]!.message).toContain('Task handler registration');
    });

    it('does not emit diagnostic when first arg is a string literal (v2 style)', () => {
        const input = [`server.setRequestHandler('tools/call', async (request) => {`, `    return { content: [] };`, `});`, ''].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = handlerRegistrationTransform.apply(sourceFile, ctx);
        expect(result.diagnostics.length).toBe(0);
    });
});

describe('custom and schema-derived handler arguments (B4)', () => {
    function applyWithDiagnostics(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = handlerRegistrationTransform.apply(sourceFile, { projectType: 'server' });
        return { text: sourceFile.getFullText(), result };
    }

    it('marks a setNotificationHandler whose first argument is a schema expression', () => {
        const code = [
            `import { Server } from '@modelcontextprotocol/sdk/server/index.js';`,
            `server.setNotificationHandler(schemas.SelectionChanged, handler);`,
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        const diag = result.diagnostics.find(d => d.insertComment && d.message.includes('setNotificationHandler'));
        expect(diag).toBeDefined();
        expect(diag?.message).toContain('three-argument custom form');
        expect(diag?.advisoryOnly).toBe(true);
    });

    it('leaves template-literal method arguments alone (valid v2 form)', () => {
        const code = [
            `import { Server } from '@modelcontextprotocol/sdk/server/index.js';`,
            'server.setRequestHandler(`${NS}/search`, { params: P }, handler);',
            'client.removeNotificationHandler(`notifications/${kind}`);',
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('leaves string-method setNotificationHandler calls alone', () => {
        const code = [
            `import { Server } from '@modelcontextprotocol/sdk/server/index.js';`,
            `server.setNotificationHandler('notifications/custom', { params: P }, handler);`,
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        expect(result.diagnostics).toHaveLength(0);
    });

    it('rewrites removeRequestHandler(Schema.shape.method.value) to the method string', () => {
        const code = [
            `import { PingRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.removeRequestHandler(PingRequestSchema.shape.method.value);`,
            ''
        ].join('\n');
        const { text } = applyWithDiagnostics(code);
        expect(text).toContain(`removeRequestHandler('ping')`);
        expect(text).not.toContain('PingRequestSchema');
    });

    it('marks removeNotificationHandler with an unresolvable schema-derived argument', () => {
        const code = [
            `import { Server } from '@modelcontextprotocol/sdk/server/index.js';`,
            `server.removeNotificationHandler(localSchema.shape.method.value);`,
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        expect(result.diagnostics.some(d => d.insertComment && d.message.includes('method string'))).toBe(true);
    });
});

describe('same-file identifier schema resolution (B6, #30)', () => {
    function applyWithDiagnostics(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = handlerRegistrationTransform.apply(sourceFile, { projectType: 'server' });
        return { text: sourceFile.getFullText(), result };
    }

    it('resolves a local const alias of a spec schema to the method string', () => {
        const code = [
            `import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const S = ListToolsRequestSchema;`,
            `server.setRequestHandler(S, handler);`,
            ''
        ].join('\n');
        const { text, result } = applyWithDiagnostics(code);
        expect(text).toContain(`setRequestHandler('tools/list', handler)`);
        expect(result.diagnostics.some(d => d.message.includes('Custom method handler'))).toBe(false);
    });

    it('still marks local variables that do not resolve to a spec schema', () => {
        const code = [
            `import { Server } from '@modelcontextprotocol/sdk/server/index.js';`,
            `const S = myCustomSchema;`,
            `server.setRequestHandler(S, handler);`,
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        expect(result.diagnostics.some(d => d.message.includes('Custom method handler'))).toBe(true);
    });
});

describe('variable-hop guard rails (B6 review)', () => {
    function applyB6(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = handlerRegistrationTransform.apply(sourceFile, { projectType: 'server' });
        return { text: sourceFile.getFullText(), result };
    }

    it('routes local aliases of removed task schemas to the removal guidance', () => {
        const code = [
            `import { ListTasksRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const T = ListTasksRequestSchema;`,
            `server.setRequestHandler(T, handler);`,
            ''
        ].join('\n');
        const { result } = applyB6(code);
        expect(result.diagnostics.some(d => d.message.includes('removed in v2 (SEP-2663)'))).toBe(true);
        expect(result.diagnostics.some(d => d.message.includes('Custom method handler'))).toBe(false);
    });

    it('keeps the custom marker when the name is shadowed', () => {
        const code = [
            `import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const S = ListToolsRequestSchema;`,
            `function inner() {`,
            `    const S = myCustomSchema;`,
            `    server.setRequestHandler(S, handler);`,
            `}`,
            ''
        ].join('\n');
        const { text, result } = applyB6(code);
        expect(text).not.toContain(`setRequestHandler('tools/list'`);
        expect(result.diagnostics.some(d => d.message.includes('Custom method handler'))).toBe(true);
    });
});

describe('stale registration-schema references (analysis: mcp-servers/memory)', () => {
    function applyWithDiagnostics(code: string) {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', code);
        const result = handlerRegistrationTransform.apply(sourceFile, { projectType: 'server' });
        return { text: sourceFile.getFullText(), result };
    }

    it('flags a request schema used as a setRequestHandler-mock assertion arg with the method string', () => {
        const code = [
            `import { SubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const schemas = inner.setRequestHandler.mock.calls.map((c) => c[0]);`,
            `expect(schemas).toContain(SubscribeRequestSchema);`,
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        const diag = result.diagnostics.find(
            d => d.message.includes('SubscribeRequestSchema') && d.message.includes("'resources/subscribe'")
        );
        expect(diag).toBeDefined();
    });

    it('flags a schema passed to a registration-lookup helper', () => {
        const code = [
            `import { UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const c = inner.setRequestHandler.mock.calls.find((x) => x[0] === s);`,
            `handlerFor(inner, UnsubscribeRequestSchema);`,
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        expect(result.diagnostics.some(d => d.message.includes("'resources/unsubscribe'"))).toBe(true);
    });

    it('does NOT flag a request schema used as a schema (.parse) — property-access base', () => {
        const code = [
            `import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));`,
            `const parsed = CallToolRequestSchema.parse(x);`,
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        expect(result.diagnostics.some(d => d.message.includes('no longer the setRequestHandler'))).toBe(false);
    });

    it('does NOT flag in a file that performs no handler registration', () => {
        const code = [
            `import { SubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `someValidator(SubscribeRequestSchema);`,
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        expect(result.diagnostics.some(d => d.message.includes('no longer the setRequestHandler'))).toBe(false);
    });

    it('does NOT flag a schema consumed by a validator when setRequestHandler is only a real registration', () => {
        // The file registers a handler for real (a call the pass rewrites); an unrelated schema-consuming
        // call like validateSchema(S) / zodToJsonSchema(S) is not a stale registration key — only a
        // setRequestHandler MOCK/lookup reference signals that surviving schema refs are stale.
        const code = [
            `import { CallToolRequestSchema, SubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [] }));`,
            `validateSchema(SubscribeRequestSchema);`,
            ''
        ].join('\n');
        const { result } = applyWithDiagnostics(code);
        expect(result.diagnostics.some(d => d.message.includes('no longer the setRequestHandler'))).toBe(false);
    });
});
