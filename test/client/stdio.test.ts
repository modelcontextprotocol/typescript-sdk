import { JSONRPCMessage } from '../../src/types.js';
import { Client } from '../../src/client/index.js';
import { StdioClientTransport, StdioServerParameters } from '../../src/client/stdio.js';

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
    await client.send(messages[0]);
    await client.send(messages[1]);
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

/** Unique markers so late-attach tests can tell drained startup bytes from post-request bytes. */
const STDERR_STARTUP_MARKER = 'STDERR_STARTUP_MARKER';
const STDERR_POST_REQUEST_MARKER = 'STDERR_POST_REQUEST_MARKER';

/**
 * Minimal MCP server that floods stderr on every post-handshake request.
 * Enough writes to fill a paused PassThrough (16 KiB) and the OS pipe (~64 KiB)
 * so an undrained `stderr: 'pipe'` would block the child on write(2).
 */
function chattyStderrServerScript(): string {
    return String.raw`
        const { createInterface } = require('readline');
        const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
        process.stderr.write(${JSON.stringify(`${STDERR_STARTUP_MARKER}\n`)});
        createInterface({ input: process.stdin }).on('line', (line) => {
            const m = JSON.parse(line);
            if (m.method === 'initialize') {
                return send({
                    jsonrpc: '2.0',
                    id: m.id,
                    result: {
                        protocolVersion: '2025-06-18',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'chatty', version: '1.0.0' }
                    }
                });
            }
            if (m.method === 'notifications/initialized') return;
            for (let i = 0; i < 256; i++) process.stderr.write('x'.repeat(512) + '\n');
            process.stderr.write(${JSON.stringify(`${STDERR_POST_REQUEST_MARKER}\n`)});
            send({
                jsonrpc: '2.0',
                id: m.id,
                result: { tools: [{ name: 'x', description: 'd', inputSchema: { type: 'object' } }] }
            });
        });
    `;
}

function chattyStderrTransport(): StdioClientTransport {
    return new StdioClientTransport({
        command: process.execPath,
        args: ['-e', chattyStderrServerScript()],
        stderr: 'pipe'
    });
}

/** stdout can settle before every flowing-mode stderr chunk is delivered. */
async function waitForStderrMarker(captured: { text: string }, marker: string): Promise<void> {
    await vi.waitFor(
        () => {
            if (!captured.text.includes(marker)) {
                throw new Error(`stderr has not yet included ${marker}`);
            }
        },
        { timeout: 3000, interval: 10 }
    );
}

test('piped stderr without a reader does not deadlock listTools', async () => {
    const transport = chattyStderrTransport();
    const client = new Client({ name: 'demo', version: '1.0.0' });
    try {
        await client.connect(transport);
        const result = await client.listTools(undefined, { timeout: 5000 });
        expect(result.tools).toEqual([{ name: 'x', description: 'd', inputSchema: { type: 'object' } }]);
    } finally {
        await client.close();
    }
}, 8000);

test('piped stderr listener attached before start still receives chunks', async () => {
    const transport = chattyStderrTransport();
    const stderr = transport.stderr;
    expect(stderr).not.toBeNull();
    const captured = { text: '' };
    stderr!.on('data', (chunk: Buffer) => {
        captured.text += chunk.toString();
    });

    const client = new Client({ name: 'demo', version: '1.0.0' });
    try {
        await client.connect(transport);
        await waitForStderrMarker(captured, STDERR_STARTUP_MARKER);
        const result = await client.listTools(undefined, { timeout: 5000 });
        expect(result.tools).toHaveLength(1);
        await waitForStderrMarker(captured, STDERR_POST_REQUEST_MARKER);
    } finally {
        await client.close();
    }
}, 8000);

test('late stderr listener does not deadlock and sees only post-attach chunks', async () => {
    const transport = chattyStderrTransport();
    const client = new Client({ name: 'demo', version: '1.0.0' });
    try {
        await client.connect(transport);
        // Flowing-mode drain of startup stderr needs a turn to settle before we attach.
        await new Promise<void>(resolve => setImmediate(resolve));

        const stderr = transport.stderr;
        expect(stderr).not.toBeNull();
        const captured = { text: '' };
        stderr!.on('data', (chunk: Buffer) => {
            captured.text += chunk.toString();
        });

        const result = await client.listTools(undefined, { timeout: 5000 });
        expect(result.tools).toHaveLength(1);
        await waitForStderrMarker(captured, STDERR_POST_REQUEST_MARKER);
        expect(captured.text.includes(STDERR_STARTUP_MARKER)).toBe(false);
    } finally {
        await client.close();
    }
}, 8000);
