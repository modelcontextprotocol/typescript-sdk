import { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { INVALID_REQUEST, InvalidJsonRpcFrameError, serializeMessage } from '@modelcontextprotocol/core-internal';

import { StdioServerTransport } from '../../src/server/stdio';

let input: Readable;
let outputChunks: Buffer[];
let output: Writable;

beforeEach(() => {
    input = new Readable({
        // We'll use input.push() instead.
        read: () => {}
    });

    outputChunks = [];
    output = new Writable({
        write(chunk, _encoding, callback) {
            outputChunks.push(Buffer.from(chunk));
            callback();
        }
    });
});

function readOutputMessages(): unknown[] {
    const output = Buffer.concat(outputChunks).toString('utf8').trim();
    if (output.length === 0) {
        return [];
    }
    return output.split('\n').map(line => JSON.parse(line));
}

async function flushEvents(): Promise<void> {
    await new Promise(resolve => setImmediate(resolve));
}

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

test('should reply with Invalid Request when a malformed JSON-RPC request has a recoverable id', async () => {
    const server = new StdioServerTransport(input, output);
    const errors: Error[] = [];
    server.onerror = error => {
        errors.push(error);
    };

    await server.start();
    input.push('{"id":99,"method":"tools/list","params":{}}\n');
    await flushEvents();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(InvalidJsonRpcFrameError);
    expect(readOutputMessages()).toEqual([
        {
            jsonrpc: '2.0',
            id: 99,
            error: { code: INVALID_REQUEST, message: 'Invalid Request' }
        }
    ]);
});

test('should reply with null id when a malformed JSON-RPC frame has no recoverable id', async () => {
    const server = new StdioServerTransport(input, output);
    const errors: Error[] = [];
    server.onerror = error => {
        errors.push(error);
    };

    await server.start();
    input.push('[{"jsonrpc":"2.0","id":100,"method":"tools/list"},{"jsonrpc":"2.0","id":101,"method":"ping"}]\n');
    await flushEvents();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(InvalidJsonRpcFrameError);
    expect(readOutputMessages()).toEqual([
        {
            jsonrpc: '2.0',
            id: null,
            error: { code: INVALID_REQUEST, message: 'Invalid Request' }
        }
    ]);
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

test('should respect custom maxBufferSize option', async () => {
    const server = new StdioServerTransport(input, output, { maxBufferSize: 100 });

    let receivedError: Error | undefined;
    server.onerror = err => {
        receivedError = err;
    };
    let closeCount = 0;
    server.onclose = () => {
        closeCount++;
    };

    await server.start();

    // Push 101 bytes without a newline — exceeds the 100-byte limit
    input.push(Buffer.alloc(101, 0x41));

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(receivedError?.message).toMatch(/ReadBuffer exceeded maximum size/);
    expect(closeCount).toBe(1);
});

test('should fire onerror and close when ReadBuffer overflows', async () => {
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

    // Push data exceeding the default 10 MB limit without a newline
    const chunk = Buffer.alloc(11 * 1024 * 1024, 0x41);
    input.push(chunk);

    // Allow the close() promise to settle
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(receivedError?.message).toMatch(/ReadBuffer exceeded maximum size/);
    expect(closeCount).toBe(1);
});
