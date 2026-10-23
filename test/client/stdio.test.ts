import { JSONRPCMessage } from '../../src/types.js';
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

test.runIf(process.platform === 'win32')('should pass an explicit Path to the child instead of the inherited PATH on Windows', async () => {
    // Use the absolute node path: the child's PATH is replaced, so a bare `node` would not resolve.
    const client = new StdioClientTransport({
        command: process.execPath,
        args: [
            '-e',
            "const keys = Object.keys(process.env).filter(k => k.toUpperCase() === 'PATH'); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'env', params: { keys, explicit: process.env.PATH === 'C:\\\\explicit-only' } }) + '\\n')"
        ],
        env: { Path: 'C:\\explicit-only' }
    });

    const received = new Promise<JSONRPCMessage>((resolve, reject) => {
        client.onmessage = resolve;
        client.onerror = reject;
        client.onclose = () => reject(new Error('child exited before reporting its environment'));
    });

    await client.start();
    const message = await received;
    await client.close();

    expect(message).toEqual({
        jsonrpc: '2.0',
        method: 'env',
        params: { keys: ['Path'], explicit: true }
    });
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
