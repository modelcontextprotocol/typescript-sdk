/**
 * Real public Client over local stdio and Streamable HTTP.
 * Compiler counts are Ajv2020 engine.compile on the default validator.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Client } from '../../src/client/client';
import { getDefaultEnvironment, StdioClientTransport } from '../../src/client/stdio';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';

const fixture = fileURLToPath(new URL('fixtures/cold-output-server.mjs', import.meta.url));

interface CompileSpy {
    compiles: number;
    restore: () => void;
}

function spyAjvCompile(): CompileSpy {
    const spy: CompileSpy = { compiles: 0, restore: () => {} };
    const prototype = Ajv2020.prototype as unknown as {
        compile: (this: unknown, schema: unknown) => unknown;
    };
    const original = prototype.compile;
    prototype.compile = function (schema: unknown) {
        spy.compiles += 1;
        return original.call(this, schema);
    };
    spy.restore = () => {
        prototype.compile = original;
    };
    return spy;
}

function client(): Client {
    return new Client({ name: 'cold-output-client', version: '1.0.0' }, { capabilities: {} });
}

describe('local stdio and HTTP callTool', () => {
    let spy: CompileSpy | undefined;
    const children: { kill: (signal?: NodeJS.Signals) => boolean }[] = [];

    afterEach(() => {
        spy?.restore();
        spy = undefined;
        for (const child of children) child.kill('SIGKILL');
        children.length = 0;
    });

    it('stdio: one ordinary call compiles only pick, including an uncalled bad schema', async () => {
        spy = spyAjvCompile();
        const report = path.join(mkdtempSync(path.join(tmpdir(), 'cold-stdio-')), 'report.json');
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fixture, 'stdio'],
            env: { ...getDefaultEnvironment(), COLD_SCENARIO: 'number', COLD_BAD: '1', COLD_FILLERS: '24', COLD_REPORT: report },
            stderr: 'pipe'
        });
        const mcp = client();
        await mcp.connect(transport);
        const listed = await mcp.listTools();
        expect(listed.tools.map(tool => tool.name)).toContain('pick');
        expect(listed.tools.map(tool => tool.name)).toContain('bad');
        expect(listed.tools).toHaveLength(26);
        expect(spy.compiles).toBe(0);

        const started = performance.now();
        await expect(mcp.callTool({ name: 'pick', arguments: {} })).resolves.toMatchObject({
            structuredContent: { count: 1 }
        });
        const callMs = performance.now() - started;
        expect(spy.compiles).toBe(1);
        expect(callMs).toBeGreaterThanOrEqual(0);

        await mcp.callTool({ name: 'pick', arguments: {} });
        expect(spy.compiles).toBe(1);

        await expect(mcp.callTool({ name: 'bad', arguments: {} })).rejects.toThrow(/invalid outputSchema/);
        expect(spy.compiles).toBe(2);

        await mcp.close();
        await transport.close();
        const events = JSON.parse(readFileSync(report, 'utf8')).events as { kind: string; name?: string }[];
        expect(events.filter(event => event.kind === 'call').map(event => event.name)).toEqual(['pick', 'pick']);
    });

    it('stdio: a changed list does not reuse the previous validator', async () => {
        spy = spyAjvCompile();
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fixture, 'stdio'],
            env: { ...getDefaultEnvironment(), COLD_SCENARIO: 'changed', COLD_FILLERS: '24' },
            stderr: 'pipe'
        });
        const mcp = client();
        await mcp.connect(transport);
        await mcp.listTools();
        await mcp.callTool({ name: 'pick', arguments: {} });
        expect(spy.compiles).toBe(1);
        await mcp.listTools();
        await expect(mcp.callTool({ name: 'pick', arguments: {} })).rejects.toThrow(/does not match the tool's output schema/);
        expect(spy.compiles).toBe(2);
        await mcp.close();
        await transport.close();
    });

    it('stdio: list_changed drops validation until the tool is listed again', async () => {
        spy = spyAjvCompile();
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fixture, 'stdio'],
            env: { ...getDefaultEnvironment(), COLD_SCENARIO: 'notify', COLD_FILLERS: '8' },
            stderr: 'pipe'
        });
        const mcp = client();
        await mcp.connect(transport);
        await mcp.listTools();
        await mcp.callTool({ name: 'pick', arguments: {} });
        await expect(mcp.callTool({ name: 'pick', arguments: {} })).resolves.toMatchObject({
            structuredContent: { label: 'after-evict' }
        });
        expect(spy.compiles).toBe(1);
        await mcp.close();
        await transport.close();
    });

    it('stdio: explicit toolDefinition compiles one schema and leaves the catalog cold', async () => {
        spy = spyAjvCompile();
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [fixture, 'stdio'],
            env: { ...getDefaultEnvironment(), COLD_SCENARIO: 'number', COLD_FILLERS: '24' },
            stderr: 'pipe'
        });
        const mcp = client();
        await mcp.connect(transport);
        await expect(
            mcp.callTool(
                { name: 'pick', arguments: {} },
                {
                    toolDefinition: {
                        name: 'pick',
                        inputSchema: { type: 'object' },
                        outputSchema: {
                            $id: 'https://example.test/cold/direct',
                            type: 'object',
                            properties: { count: { type: 'number' } },
                            required: ['count'],
                            additionalProperties: false
                        }
                    }
                }
            )
        ).resolves.toMatchObject({ structuredContent: { count: 1 } });
        expect(spy.compiles).toBe(1);
        await mcp.close();
        await transport.close();
    });

    it('HTTP: discovery stays complete and one call compiles only pick', async () => {
        spy = spyAjvCompile();
        const report = path.join(mkdtempSync(path.join(tmpdir(), 'cold-http-')), 'report.json');
        const child = spawn(process.execPath, [fixture, 'http'], {
            env: { ...process.env, COLD_SCENARIO: 'number', COLD_BAD: '1', COLD_FILLERS: '24', COLD_REPORT: report },
            stdio: ['ignore', 'ignore', 'pipe']
        });
        children.push(child);
        const port = await new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fixture did not listen')), 5000);
            let buffer = '';
            child.stderr?.on('data', chunk => {
                buffer += chunk.toString();
                const match = /COLD_PORT (\d+)/.exec(buffer);
                if (match?.[1] !== undefined) {
                    clearTimeout(timer);
                    resolve(Number(match[1]));
                }
            });
            child.once('exit', code => {
                clearTimeout(timer);
                reject(new Error(`fixture exited ${code} before listen: ${buffer}`));
            });
        });

        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
        const mcp = client();
        const errors: unknown[] = [];
        mcp.onerror = error => errors.push(error);
        await mcp.connect(transport);
        const listed = await mcp.listTools();
        expect(listed.tools).toHaveLength(26);
        expect(spy.compiles).toBe(0);
        const started = performance.now();
        await expect(mcp.callTool({ name: 'pick', arguments: {} })).resolves.toMatchObject({
            structuredContent: { count: 1 }
        });
        const callMs = performance.now() - started;
        expect(spy.compiles).toBe(1);
        expect(callMs).toBeGreaterThanOrEqual(0);
        await expect(mcp.callTool({ name: 'bad', arguments: {} })).rejects.toThrow(/invalid outputSchema/);
        expect(spy.compiles).toBe(2);
        expect(errors).toEqual([]);
        await mcp.close();
        await transport.close();
        child.kill('SIGTERM');
        await new Promise(resolve => child.once('exit', resolve));
        const events = JSON.parse(readFileSync(report, 'utf8')).events as { kind: string; name?: string }[];
        expect(events.filter(event => event.kind === 'call').map(event => event.name)).toEqual(['pick']);
    });

    it('HTTP: refreshing a changed catalog invalidates the called validator only', async () => {
        spy = spyAjvCompile();
        const child = spawn(process.execPath, [fixture, 'http'], {
            env: { ...process.env, COLD_SCENARIO: 'changed', COLD_FILLERS: '24' },
            stdio: ['ignore', 'ignore', 'pipe']
        });
        children.push(child);
        const port = await new Promise<number>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('fixture did not listen')), 5000);
            let buffer = '';
            child.stderr?.on('data', chunk => {
                buffer += chunk.toString();
                const match = /COLD_PORT (\d+)/.exec(buffer);
                if (match?.[1] !== undefined) {
                    clearTimeout(timer);
                    resolve(Number(match[1]));
                }
            });
        });
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
        const mcp = client();
        await mcp.connect(transport);
        await mcp.listTools();
        await mcp.callTool({ name: 'pick', arguments: {} });
        await mcp.listTools();
        await expect(mcp.callTool({ name: 'pick', arguments: {} })).rejects.toThrow(/does not match the tool's output schema/);
        expect(spy.compiles).toBe(2);
        await mcp.close();
        await transport.close();
        child.kill('SIGTERM');
    });
});
