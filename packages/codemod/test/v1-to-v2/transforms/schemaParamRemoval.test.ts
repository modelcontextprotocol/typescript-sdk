import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { schemaParamRemovalTransform } from '../../../src/migrations/v1-to-v2/transforms/schemaParamRemoval';
import type { TransformContext } from '../../../src/types';

const ctx: TransformContext = { projectType: 'client' };

function applyTransform(code: string): string {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('test.ts', code);
    schemaParamRemovalTransform.apply(sourceFile, ctx);
    return sourceFile.getFullText();
}

describe('schema-param-removal transform', () => {
    it('removes schema from client.request()', () => {
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.request({ method: 'tools/call', params: {} }, CallToolResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("client.request({ method: 'tools/call', params: {} })");
        expect(result).not.toContain('CallToolResultSchema');
    });

    it('removes schema from client.callTool()', () => {
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.callTool({ name: 'test', arguments: {} }, CallToolResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("client.callTool({ name: 'test', arguments: {} })");
        expect(result).not.toContain('CallToolResultSchema');
    });

    it('does not remove schema from generic send() calls', () => {
        const input = [
            `import { CreateMessageResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await ctx.mcpReq.send({ method: 'sampling/createMessage', params: {} }, CreateMessageResultSchema, { timeout: 5000 });`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('CreateMessageResultSchema');
        expect(result).toContain('{ timeout: 5000 }');
    });

    it('does not remove non-schema arguments', () => {
        const input = [`const result = await client.request({ method: 'tools/call' }, { timeout: 5000 });`, ''].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('{ timeout: 5000 }');
    });

    it('does not remove custom schemas not imported from MCP', () => {
        const input = [
            `import { MyCustomSchema } from './my-schemas';`,
            `const result = await client.request(params, MyCustomSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('MyCustomSchema');
    });

    it('does not remove a non-MCP schema from extra.sendRequest() for a custom method', () => {
        const input = [
            `import { MySchema } from './my-schemas';`,
            `const result = await extra.sendRequest({ method: 'acme/x', params }, MySchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        // The schema arg and its import must be left alone — only MCP-imported
        // *Schema identifiers are stripped (same guard as the request/callTool path).
        expect(result).toContain("extra.sendRequest({ method: 'acme/x', params }, MySchema)");
        expect(result).toContain(`import { MySchema } from './my-schemas';`);
    });

    it('is idempotent', () => {
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.request({ method: 'tools/call' }, CallToolResultSchema);`,
            ''
        ].join('\n');
        const first = applyTransform(input);
        const second = applyTransform(first);
        expect(second).toBe(first);
    });

    it('does not remove schema from generic sendRequest calls', () => {
        const input = [
            `import { CreateMessageResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await extra.sendRequest({ method: 'sampling/createMessage', params }, CreateMessageResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('CreateMessageResultSchema');
        expect(result).toContain('extra.sendRequest(');
    });

    it('does not remove aliased schema from generic sendRequest calls', () => {
        const input = [
            `import { CreateMessageResultSchema as CMRS } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await extra.sendRequest({ method: 'sampling/createMessage', params }, CMRS);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('CMRS');
        expect(result).toContain('extra.sendRequest(');
    });

    it('counts one change per removed schema argument', () => {
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.request({ method: 'tools/call' }, CallToolResultSchema);`,
            ''
        ].join('\n');
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile('test.ts', input);
        const result = schemaParamRemovalTransform.apply(sourceFile, { projectType: 'unknown' });
        expect(result.changesCount).toBe(1);
    });

    it('removes the import declaration when all schemas are removed', () => {
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.request({ method: 'tools/call' }, CallToolResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).not.toMatch(/import.*CallToolResultSchema/);
    });

    it('removes a literal undefined schema slot from callTool when an options argument follows', () => {
        const input = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `const result = await client.callTool({ name: 'add', arguments: { a: 1 } }, undefined, { onprogress: cb });`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("client.callTool({ name: 'add', arguments: { a: 1 } }, { onprogress: cb })");
        expect(result).not.toContain(', undefined,');
    });

    it('removes a literal undefined schema slot from request when an options argument follows', () => {
        const input = [
            `import { Client } from '@modelcontextprotocol/sdk/client/index.js';`,
            `const result = await client.request({ method: 'tools/call', params: {} }, undefined, { timeout: 5000 });`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("client.request({ method: 'tools/call', params: {} }, { timeout: 5000 })");
        expect(result).not.toContain(', undefined,');
    });

    it('does not strip undefined from request()/callTool() in a file with no MCP imports', () => {
        // `request`/`callTool` are common non-MCP method names; without an MCP signal in the file the
        // codemod must not touch them, or it would shift `someHttpClient.request(payload, undefined, opts)`.
        const input = [`const r = await someHttpClient.request(payload, undefined, { timeout: 5000 });`, ''].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('someHttpClient.request(payload, undefined, { timeout: 5000 })');
    });

    it('leaves a 2-arg callTool(params, undefined) unchanged (already valid as options in v2)', () => {
        const input = [`await client.callTool({ name: 'add' }, undefined);`, ''].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('undefined');
    });

    it('keeps the schema (and its import) when request() has a shorthand dynamic method', () => {
        // The proxy/forwarder shape: schema-less v2 request() would enforce spec result
        // schemas and resolve `undefined` for unknown methods — the schema must survive.
        const input = [
            `import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await upstream.request({ method, params }, ResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('request({ method, params }, ResultSchema)');
        expect(result).toMatch(/import.*ResultSchema/);
    });

    it('keeps the schema when request() has a variable method property', () => {
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.request({ method: m, params: {} }, CallToolResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('CallToolResultSchema)');
    });

    it('keeps the schema when the request object is not an object literal', () => {
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await relay.request(inbound, CallToolResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('relay.request(inbound, CallToolResultSchema)');
    });

    it('keeps the generic passthrough ResultSchema even for a literal spec method', () => {
        // Dropping it would switch the call from passthrough validation to spec-schema
        // enforcement — a silent semantic change.
        const input = [
            `import { ResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.request({ method: 'ping' }, ResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("request({ method: 'ping' }, ResultSchema)");
    });

    it('keeps an aliased passthrough ResultSchema', () => {
        const input = [
            `import { ResultSchema as RS } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.request({ method: 'tools/call' }, RS);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain("request({ method: 'tools/call' }, RS)");
    });

    it('still removes the schema for a no-substitution template-literal method', () => {
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            'const result = await client.request({ method: `tools/call`, params: {} }, CallToolResultSchema);',
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).not.toContain('CallToolResultSchema)');
    });

    it('still removes the schema when the literal method is wrapped in `as const`', () => {
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.request({ method: 'tools/call' as const, params: {} }, CallToolResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).not.toContain('CallToolResultSchema)');
    });

    it('keeps the schema when a spread follows the method property', () => {
        // `{ method: 'tools/call', ...rest }` — rest can override method at runtime.
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.request({ method: 'tools/call', ...rest }, CallToolResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('CallToolResultSchema)');
    });

    it('still removes the schema from callTool() with a variable params object', () => {
        // v2 callTool() has no schema parameter — the argument goes regardless of shape.
        const input = [
            `import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await client.callTool(callParams, CallToolResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('client.callTool(callParams)');
        expect(result).not.toContain('CallToolResultSchema');
    });
});
