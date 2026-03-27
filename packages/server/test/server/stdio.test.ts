import { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { InvalidJSONRPCMessageError, ProtocolErrorCode, ReadBuffer, serializeMessage } from '@modelcontextprotocol/core';

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

    input.push(Buffer.from(serializeMessage(messages[0]!) + serializeMessage(messages[1]!)));

    await server.start();
    await finished;
    expect(readMessages).toEqual(messages);
});

test('should close and fire onerror when stdout errors', async () => {
    const server = new StdioServerTransport(input, output);

    let receivedError: Error | undefined;
    server.onerror = err => {
        receivedError = err;
    };
    let closeCount = 0;
    server.onclose = () => {
        closeCount++;
    };

    await server.start();
    output.emit('error', new Error('EPIPE'));

    expect(receivedError?.message).toBe('EPIPE');
    expect(closeCount).toBe(1);
});

test('should not fire onclose twice when close() is called after stdout error', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = () => {};

    let closeCount = 0;
    server.onclose = () => {
        closeCount++;
    };

    await server.start();
    output.emit('error', new Error('EPIPE'));
    await server.close();

    expect(closeCount).toBe(1);
});

test('should reject send() when stdout errors before drain', async () => {
    let completeWrite: ((error?: Error | null) => void) | undefined;
    const slowOutput = new Writable({
        highWaterMark: 0,
        write(_chunk, _encoding, callback) {
            completeWrite = callback;
        }
    });

    const server = new StdioServerTransport(input, slowOutput);
    server.onerror = () => {};
    await server.start();

    const sendPromise = server.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    completeWrite!(new Error('write EPIPE'));

    await expect(sendPromise).rejects.toThrow('write EPIPE');
    expect(slowOutput.listenerCount('drain')).toBe(0);
    expect(slowOutput.listenerCount('error')).toBe(0);
});

test('should reject send() after transport is closed', async () => {
    const server = new StdioServerTransport(input, output);
    await server.start();
    await server.close();

    await expect(server.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toThrow('closed');
});

test('should fire onerror before onclose on stdout error', async () => {
    const server = new StdioServerTransport(input, output);

    const events: string[] = [];
    server.onerror = () => events.push('error');
    server.onclose = () => events.push('close');

    await server.start();
    output.emit('error', new Error('EPIPE'));

    expect(events).toEqual(['error', 'close']);
});

test('should send an invalid request error for schema-invalid JSON-RPC and continue reading', async () => {
    const server = new StdioServerTransport(input, output);
    const receivedErrors: Error[] = [];
    const validMessage: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping'
    };

    server.onerror = error => {
        receivedErrors.push(error);
    };

    const validMessageReceived = new Promise<void>(resolve => {
        server.onmessage = message => {
            if (JSON.stringify(message) === JSON.stringify(validMessage)) {
                resolve();
            }
        };
    });

    await server.start();
    input.push(Buffer.from('{"jsonrpc":"2.0","id":9007199254740992,"method":"ping"}\n' + serializeMessage(validMessage)));

    await validMessageReceived;

    expect(receivedErrors).toHaveLength(1);
    expect(receivedErrors[0]).toBeInstanceOf(InvalidJSONRPCMessageError);
    expect(outputBuffer.readMessage()).toEqual({
        jsonrpc: '2.0',
        error: {
            code: ProtocolErrorCode.InvalidRequest,
            message: 'Invalid Request'
        }
    });
    expect(outputBuffer.readMessage()).toBeNull();
});
