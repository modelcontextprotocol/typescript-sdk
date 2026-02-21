import { Readable, Writable, PassThrough } from 'node:stream';

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

test('should forward stdout errors to onerror', async () => {
    const server = new StdioServerTransport(input, output);

    const errorReceived = new Promise<Error>(resolve => {
        server.onerror = error => {
            resolve(error);
        };
    });

    await server.start();

    // Simulate an EPIPE error on stdout
    const epipeError = new Error('write EPIPE');
    (epipeError as NodeJS.ErrnoException).code = 'EPIPE';
    output.destroy(epipeError);

    const receivedError = await errorReceived;
    expect(receivedError.message).toBe('write EPIPE');
});

test('should not crash when stdout emits error after client disconnect', async () => {
    // Create a writable that will emit an EPIPE error on write
    const brokenOutput = new Writable({
        write(_chunk, _encoding, callback) {
            const error = new Error('write EPIPE') as NodeJS.ErrnoException;
            error.code = 'EPIPE';
            callback(error);
        }
    });

    const server = new StdioServerTransport(input, brokenOutput);

    const errors: Error[] = [];
    server.onerror = error => {
        errors.push(error);
    };

    await server.start();

    const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 1,
        result: {}
    };

    // This should not throw an unhandled error
    await expect(server.send(message)).rejects.toThrow('write EPIPE');
    await server.close();
});

test('should clean up stdout error listener on close', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = () => {};

    await server.start();
    const listenersBeforeClose = output.listenerCount('error');

    await server.close();
    const listenersAfterClose = output.listenerCount('error');

    expect(listenersAfterClose).toBeLessThan(listenersBeforeClose);
});
