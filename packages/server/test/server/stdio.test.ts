import { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/core';

import { StdioServerTransport } from '../../src/server/stdio.js';

let input: Readable;
let outputBuffer: ReadBuffer;
let output: Writable;

beforeEach(() => {
    input = new Readable({
        // We'll use input.push() instead.
        read: () => {}
    });

    outputBuffer = new ReadBuffer();
    output = new Writable({
        write(chunk, _encoding, callback) {
            outputBuffer.append(chunk);
            callback();
        }
    });
});

test('should start then close cleanly', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
        throw error;
    };

    let didClose = false;
    server.onclose = () => {
        didClose = true;
    };

    await server.start();
    expect(didClose).toBeFalsy();
    await server.close();
    expect(didClose).toBeTruthy();
});

test('should not read until started', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
        throw error;
    };

    let didRead = false;
    const readMessage = new Promise(resolve => {
        server.onmessage = message => {
            didRead = true;
            resolve(message);
        };
    });

    const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping'
    };
    input.push(serializeMessage(message));

    expect(didRead).toBeFalsy();
    await server.start();
    expect(await readMessage).toEqual(message);
});

test('should close transport when stdin ends', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
        throw error;
    };

    let didClose = false;
    server.onclose = () => {
        didClose = true;
    };

    await server.start();
    expect(didClose).toBeFalsy();

    // Simulate the client closing stdin (EOF)
    input.push(null);

    // Allow the event to propagate
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(didClose).toBeTruthy();
});

test('should invoke onclose only once when close() is called then stdin ends', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
        throw error;
    };

    let closeCount = 0;
    server.onclose = () => {
        closeCount++;
    };

    await server.start();

    // Explicit close, then stdin EOF arrives
    await server.close();
    input.push(null);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(closeCount).toBe(1);
});

test('should close cleanly on EOF after a partial message', async () => {
    const server = new StdioServerTransport(input, output);

    const errors: Error[] = [];
    server.onerror = error => {
        errors.push(error);
    };

    let didClose = false;
    server.onclose = () => {
        didClose = true;
    };

    await server.start();

    // Push an incomplete JSON-RPC message (no trailing newline)
    input.push(Buffer.from('{"jsonrpc":"2.0"'));
    // Then EOF
    input.push(null);

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(didClose).toBeTruthy();
    expect(errors).toHaveLength(0);
});

test('should read multiple messages', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
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
        server.onmessage = message => {
            readMessages.push(message);
            if (JSON.stringify(message) === JSON.stringify(messages[1])) {
                resolve();
            }
        };
    });

    input.push(serializeMessage(messages[0]!));
    input.push(serializeMessage(messages[1]!));

    await server.start();
    await finished;
    expect(readMessages).toEqual(messages);
});
