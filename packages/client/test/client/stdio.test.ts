import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';

import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';

import { Client } from '../../src/client/client';
import type { StdioServerParameters } from '../../src/client/stdio';
import { StdioClientTransport } from '../../src/client/stdio';

// Configure default server parameters based on OS
// Uses 'more' command for Windows and 'tee' command for Unix/Linux
const getDefaultServerParameters = (): StdioServerParameters => {
    if (process.platform === 'win32') {
        return { command: 'more' };
    }
    return { command: '/usr/bin/tee' };
};

const serverParameters = getDefaultServerParameters();

test('should start then close cleanly', async () => {
    const client = new StdioClientTransport(serverParameters);
    client.onerror = error => {
        throw error;
    };

    let didClose = false;
    client.onclose = () => {
        didClose = true;
    };

    await client.start();
    expect(didClose).toBeFalsy();
    await client.close();
    expect(didClose).toBeTruthy();
});

test('should read messages', async () => {
    const client = new StdioClientTransport(serverParameters);
    client.onerror = error => {
        throw error;
    };

    const messages: JSONRPCMessage[] = [
        {
            jsonrpc: '2.0',
            id: 1,
            method: 'ping'
        },
        {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
        }
    ];

    const readMessages: JSONRPCMessage[] = [];
    const finished = new Promise<void>(resolve => {
        client.onmessage = message => {
            readMessages.push(message);

            if (JSON.stringify(message) === JSON.stringify(messages[1])) {
                resolve();
            }
        };
    });

    await client.start();
    await client.send(messages[0]!);
    await client.send(messages[1]!);
    await finished;
    expect(readMessages).toEqual(messages);

    await client.close();
});

test('should return child process pid', async () => {
    const client = new StdioClientTransport(serverParameters);

    await client.start();
    expect(client.pid).not.toBeNull();
    await client.close();
    expect(client.pid).toBeNull();
});

test('should respect custom maxBufferSize option', async () => {
    const client = new StdioClientTransport({
        command: 'node',
        args: ['-e', 'process.stdout.write(Buffer.alloc(200, 0x41))'],
        maxBufferSize: 100
    });

    const errorReceived = new Promise<Error>(resolve => {
        client.onerror = resolve;
    });
    const closed = new Promise<void>(resolve => {
        client.onclose = () => resolve();
    });

    await client.start();

    const error = await errorReceived;
    expect(error.message).toMatch(/ReadBuffer exceeded maximum size/);
    await closed;
});

test('should fire onerror and close when ReadBuffer overflows', async () => {
    const client = new StdioClientTransport({
        command: 'node',
        args: ['-e', 'process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 0x41))']
    });

    const errorReceived = new Promise<Error>(resolve => {
        client.onerror = resolve;
    });
    const closed = new Promise<void>(resolve => {
        client.onclose = () => resolve();
    });

    await client.start();

    const error = await errorReceived;
    expect(error.message).toMatch(/ReadBuffer exceeded maximum size/);
    await closed;
});

test('an awaiting caller learns why the connection closed when the read buffer overflows', async () => {
    // The shape from #2775: the transport reports the cause on onerror and
    // closes; without a reason on the close, `await client.listTools()` was
    // rejected with a bare `Connection closed` and the diagnosis was only
    // visible to code that had wired up onerror in advance.
    const server = String.raw`
        const { createInterface } = require('readline');
        const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
        createInterface({ input: process.stdin }).on('line', (line) => {
            const m = JSON.parse(line);
            if (m.method === 'initialize') {
                return send({ jsonrpc: '2.0', id: m.id, result: {
                    protocolVersion: '2025-06-18', capabilities: { tools: {} },
                    serverInfo: { name: 'big', version: '1.0.0' } } });
            }
            if (m.method === 'notifications/initialized') return;
            send({ jsonrpc: '2.0', id: m.id, result: {
                tools: [{ name: 'big', description: 'A'.repeat(4096), inputSchema: { type: 'object' } }] } });
        });
    `;
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['-e', server],
        maxBufferSize: 1024
    });
    const client = new Client({ name: 'demo', version: '1.0.0' });
    await client.connect(transport);

    const error = await client.listTools().catch(e => e);
    expect(error).toBeInstanceOf(SdkError);
    expect(error.code).toBe(SdkErrorCode.ConnectionClosed);
    expect(error.message).toMatch(/^Connection closed: ReadBuffer exceeded maximum size of 1024 bytes/);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toMatch(/ReadBuffer exceeded maximum size/);
}, 10_000);

test('_dispose releases the parent-side pipe handles even when a helper process holds the child stdio', async () => {
    // The rmcp-holding anatomy: the child exits, but a helper it spawned with
    // stdio: 'inherit' keeps the pipe write ends open. Awaiting 'exit' settles
    // disposal promptly — but without destroying the PARENT-side handles, the
    // flowing stdout read handle stays ref'd until the helper exits, pinning
    // the host's event loop (indefinitely for a daemon helper).
    const readyFile = `${tmpdir()}/mcp-dispose-ready-${process.pid}-${Date.now()}`;
    const HOLDING_SCRIPT = String.raw`
        const { spawn } = require('child_process');
        spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'inherit' });
        require('fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready');
        process.stdin.on('end', () => process.exit(0));
        process.stdin.resume();
    `;
    const transport = new StdioClientTransport({ command: process.execPath, args: ['-e', HOLDING_SCRIPT] });
    await transport.start();
    // Wait until the grandchild actually exists and holds the inherited pipes
    // — disposing earlier would kill the child before its script even runs.
    while (!existsSync(readyFile)) await new Promise(resolve => setTimeout(resolve, 25));
    const proc = (transport as unknown as { _process: import('node:child_process').ChildProcess })._process;

    await (transport as unknown as { _dispose: () => Promise<void> })._dispose();

    // The child is confirmed gone AND the parent-side handles are released —
    // destroyed flags are the deterministic proxy for "nothing pins the loop".
    expect(proc.stdout?.destroyed).toBe(true);
    expect(proc.stdin?.destroyed).toBe(true);
}, 10_000);
