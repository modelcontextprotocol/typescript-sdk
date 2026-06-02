import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core';

import type { StdioServerParameters } from '../../src/client/stdio.js';
import { StdioClientTransport } from '../../src/client/stdio.js';

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

test('should surface MessageTooLarge via onerror and keep running when maxMessageBytes is exceeded', async () => {
    // `tee`/`more` echo stdin back on stdout, so an oversized outbound message
    // becomes an oversized inbound message.
    const client = new StdioClientTransport(serverParameters, { maxMessageBytes: 1024 });

    const errors: Error[] = [];
    const oversizedReported = new Promise<void>(resolve => {
        client.onerror = error => {
            errors.push(error);
            resolve();
        };
    });

    const messages: JSONRPCMessage[] = [];
    const smallMessageEchoed = new Promise<void>(resolve => {
        client.onmessage = message => {
            messages.push(message);
            resolve();
        };
    });

    await client.start();

    const oversized: JSONRPCMessage = {
        jsonrpc: '2.0',
        method: 'oversized',
        params: { payload: 'x'.repeat(10_000) }
    };
    await client.send(oversized);
    await oversizedReported;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SdkError);
    expect((errors[0] as SdkError).code).toBe(SdkErrorCode.MessageTooLarge);

    // The transport recovers: a small message still round-trips.
    const small: JSONRPCMessage = { jsonrpc: '2.0', method: 'small' };
    await client.send(small);
    await smallMessageEchoed;
    expect(messages).toEqual([small]);

    await client.close();
});

test('should recover when a child floods stdout without a newline', async () => {
    // A misbehaving server that writes a large amount of data with no message
    // boundary, then a valid message: the limit must trip while the flood is
    // still incomplete, and the transport must recover at the newline.
    const childScript = [
        "process.stdout.write('x'.repeat(1_000_000));",
        "process.stdout.write('\\n');",
        "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'after-flood' }) + '\\n');",
        'setInterval(() => {}, 1 << 30);'
    ].join(' ');

    const client = new StdioClientTransport({ command: process.execPath, args: ['-e', childScript] }, { maxMessageBytes: 65_536 });

    const errors: Error[] = [];
    client.onerror = error => {
        errors.push(error);
    };

    const messages: JSONRPCMessage[] = [];
    const messageAfterFlood = new Promise<void>(resolve => {
        client.onmessage = message => {
            messages.push(message);
            resolve();
        };
    });

    await client.start();
    await messageAfterFlood;

    expect(messages).toEqual([{ jsonrpc: '2.0', method: 'after-flood' }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SdkError);
    expect((errors[0] as SdkError).code).toBe(SdkErrorCode.MessageTooLarge);

    await client.close();
});
