import process from 'node:process';
import { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/core';

import type { StdioServerTransportOptions } from '../../src/server/stdio.js';
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

test('should accept options object constructor', async () => {
    const server = new StdioServerTransport({ stdin: input, stdout: output });
    server.onerror = error => {
        throw error;
    };

    let didClose = false;
    server.onclose = () => {
        didClose = true;
    };

    await server.start();
    await server.close();
    expect(didClose).toBeTruthy();
});

describe('host process watchdog', () => {
    test('should close transport when host process is gone', async () => {
        // Use a PID that does not exist
        const deadPid = 2147483647;
        const server = new StdioServerTransport({
            stdin: input,
            stdout: output,
            clientProcessId: deadPid,
            watchdogIntervalMs: 100
        });

        const closed = new Promise<void>(resolve => {
            server.onclose = () => resolve();
        });

        await server.start();

        // Watchdog should detect the dead PID and close
        await closed;
    }, 10000);

    test('should not close when host process is alive', async () => {
        // Use our own PID — always alive
        const server = new StdioServerTransport({
            stdin: input,
            stdout: output,
            clientProcessId: process.pid,
            watchdogIntervalMs: 100
        });

        let didClose = false;
        server.onclose = () => {
            didClose = true;
        };

        await server.start();

        // Wait for several watchdog cycles
        await new Promise(resolve => setTimeout(resolve, 350));
        expect(didClose).toBe(false);

        await server.close();
    });

    test('should stop watchdog on close', async () => {
        const server = new StdioServerTransport({
            stdin: input,
            stdout: output,
            clientProcessId: process.pid,
            watchdogIntervalMs: 100
        });

        await server.start();
        await server.close();

        // If watchdog was not stopped, it would keep running — verify no errors after close
        await new Promise(resolve => setTimeout(resolve, 300));
    });
});
