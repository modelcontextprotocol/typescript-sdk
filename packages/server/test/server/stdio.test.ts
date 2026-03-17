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

test('should handle EPIPE error on stdout gracefully', async () => {
    const server = new StdioServerTransport(input, output);

    let didClose = false;
    server.onclose = () => {
        didClose = true;
    };

    await server.start();

    // Simulate EPIPE error on stdout
    const epipeError = new Error('write EPIPE') as NodeJS.ErrnoException;
    epipeError.code = 'EPIPE';
    output.emit('error', epipeError);

    // Should trigger graceful close, not crash
    expect(didClose).toBeTruthy();
});

test('should handle ERR_STREAM_DESTROYED error on stdout gracefully', async () => {
    const server = new StdioServerTransport(input, output);

    let didClose = false;
    server.onclose = () => {
        didClose = true;
    };

    await server.start();

    const destroyedError = new Error('stream destroyed') as NodeJS.ErrnoException;
    destroyedError.code = 'ERR_STREAM_DESTROYED';
    output.emit('error', destroyedError);

    expect(didClose).toBeTruthy();
});

test('should forward non-EPIPE stdout errors to onerror', async () => {
    const server = new StdioServerTransport(input, output);

    let reportedError: Error | undefined;
    server.onerror = error => {
        reportedError = error;
    };

    await server.start();

    const otherError = new Error('some other error') as NodeJS.ErrnoException;
    otherError.code = 'ENOSPC';
    output.emit('error', otherError);

    expect(reportedError).toBe(otherError);
});

test('should reject send when stdout is not writable', async () => {
    const closedOutput = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        }
    });
    closedOutput.destroy();

    const server = new StdioServerTransport(input, closedOutput);
    await server.start();

    const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping'
    };

    await expect(server.send(message)).rejects.toThrow('stdout is not writable');
});

test('should remove stdout error listener on close', async () => {
    const server = new StdioServerTransport(input, output);
    await server.start();

    const listenersBefore = output.listenerCount('error');
    await server.close();
    const listenersAfter = output.listenerCount('error');

    expect(listenersAfter).toBeLessThan(listenersBefore);
});

test('should reject send and close when EPIPE fires while waiting for drain', async () => {
    // Create a stream where write() returns false to trigger drain waiting
    const slowOutput = new Writable({
        highWaterMark: 1,
        write(_chunk, _encoding, callback) {
            // Delay callback to keep backpressure
            setTimeout(callback, 100);
        }
    });

    const server = new StdioServerTransport(input, slowOutput);

    let didClose = false;
    server.onclose = () => {
        didClose = true;
    };

    await server.start();

    // Fill the buffer so write() returns false
    const message: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping'
    };

    // Start a send that will wait for drain
    const sendPromise = server.send(message);

    // Give the event loop a tick so the write() call executes
    await new Promise(resolve => setTimeout(resolve, 10));

    // Emit EPIPE before drain fires
    const epipeError = new Error('write EPIPE') as NodeJS.ErrnoException;
    epipeError.code = 'EPIPE';
    slowOutput.emit('error', epipeError);

    // The send promise should reject (not hang forever)
    await expect(sendPromise).rejects.toThrow('Transport closed before drain');
    expect(didClose).toBeTruthy();
});
