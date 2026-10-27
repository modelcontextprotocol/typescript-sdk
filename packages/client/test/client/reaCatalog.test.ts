import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { expect, it, vi } from 'vitest';

import { Client } from '../../src/client/client';
import { getDefaultEnvironment, StdioClientTransport } from '../../src/client/stdio';
import { AjvJsonSchemaValidator } from '../../src/validators/ajv';

it('validates responses against the complete public REA catalog and reuses compiled schemas', async () => {
    const bytes = readFileSync(new URL('fixtures/rea-170-tools.json', import.meta.url));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('badac148871025e4ac3f4b71c8914c25b4d32d973d07a28f60ed799764906f2b');
    const catalog = JSON.parse(bytes.toString('utf8'));
    const validator = new AjvJsonSchemaValidator();
    const prepare = vi.spyOn(validator, 'getValidator');
    const compile = vi.spyOn(Ajv2020.prototype, 'compile');
    const mcp = new Client({ name: 'rea-catalog-client', version: '1.0.0' }, { jsonSchemaValidator: validator });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('fixtures/rea-catalog-server.mjs', import.meta.url))],
        env: getDefaultEnvironment(),
        stderr: 'pipe'
    });

    try {
        await mcp.connect(transport);
        const listed = await mcp.listTools();
        expect(listed.tools).toEqual(catalog.tools);
        expect(listed.tools).toHaveLength(170);
        expect(listed.tools.filter(tool => tool.outputSchema !== undefined)).toHaveLength(170);
        expect(prepare).not.toHaveBeenCalled();
        expect(compile).not.toHaveBeenCalled();

        const started = performance.now();
        await expect(mcp.callTool({ name: 'close_binary', arguments: {} })).resolves.toMatchObject({
            structuredContent: { result: null }
        });
        const cold = {
            preparations: prepare.mock.calls.length,
            compilations: compile.mock.calls.length,
            callMs: performance.now() - started
        };
        expect(cold.compilations).toBeGreaterThan(0);

        await expect(mcp.callTool({ name: 'close_binary', arguments: {} })).rejects.toThrow(/does not match the tool's output schema/);
        await expect(mcp.callTool({ name: 'close_binary', arguments: {} })).resolves.toMatchObject({
            structuredContent: { result: null }
        });
        expect(prepare).toHaveBeenCalledTimes(cold.preparations);
        expect(compile).toHaveBeenCalledTimes(cold.compilations);

        await mcp.listTools();
        await mcp.callTool({ name: 'close_binary', arguments: {} });
        expect(compile).toHaveBeenCalledTimes(cold.compilations);
        console.info(
            JSON.stringify({
                fixture: 'rea-170-tools',
                cold,
                afterRefresh: { preparations: prepare.mock.calls.length, compilations: compile.mock.calls.length }
            })
        );
    } finally {
        try {
            await mcp.close();
        } finally {
            try {
                await transport.close();
            } finally {
                prepare.mockRestore();
                compile.mockRestore();
            }
        }
    }
}, 30000);
