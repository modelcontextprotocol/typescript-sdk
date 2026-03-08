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

test('should handle stdout write errors gracefully', async () => {
    const brokenOutput = new Writable({
        write(_chunk, _encoding, callback) {
            callback(new Error('write EPIPE'));
        }
    });

    const server = new StdioServerTransport(input, brokenOutput);

    const errors: Error[] = [];
    server.onerror = error => {
        errors.push(error);
    };

    let didClose = false;
    server.onclose = () => {
        didClose = true;
    };

    await server.start();

    const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 1,
        result: {}
    };

    // The send itself should resolve (write returns true before async error),
    // but the error handler on the stream should fire and trigger close.
    await server.send(message);

    // Allow the async error callback to fire
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toContain('EPIPE');
    expect(didClose).toBe(true);
});

test('should handle synchronous stdout write throws gracefully', async () => {
    const throwingOutput = new Writable({
        write() {
            throw new Error('write EPIPE');
        }
    });

    const server = new StdioServerTransport(input, throwingOutput);
    server.onerror = () => {};

    await server.start();

    const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 1,
        result: {}
    };

    // send() should reject instead of crashing the process
    await expect(server.send(message)).rejects.toThrow('EPIPE');
});
