import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';

import { schemaParamRemovalTransform } from '../../../src/migrations/v1-to-v2/transforms/schemaParamRemoval.js';
import type { TransformContext } from '../../../src/types.js';

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

    it('removes schema from send() and shifts options arg', () => {
        const input = [
            `import { CreateMessageResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await ctx.mcpReq.send({ method: 'sampling/createMessage', params: {} }, CreateMessageResultSchema, { timeout: 5000 });`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).toContain('send(');
        expect(result).toContain('{ timeout: 5000 }');
        expect(result).not.toContain('CreateMessageResultSchema');
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

    it('removes schema from v1 sendRequest calls', () => {
        const input = [
            `import { CreateMessageResultSchema } from '@modelcontextprotocol/sdk/types.js';`,
            `const result = await extra.sendRequest({ method: 'sampling/createMessage', params }, CreateMessageResultSchema);`,
            ''
        ].join('\n');
        const result = applyTransform(input);
        expect(result).not.toContain('CreateMessageResultSchema');
        expect(result).toContain('extra.sendRequest(');
    });
});
