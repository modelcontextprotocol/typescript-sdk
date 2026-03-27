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
