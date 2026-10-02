import { Readable, Writable } from 'node:stream';
import { ReadBuffer, serializeMessage } from '../../src/shared/stdio.js';
import { JSONRPCMessage } from '../../src/types.js';
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
        write(chunk, encoding, callback) {
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

    input.push(serializeMessage(messages[0]));
    input.push(serializeMessage(messages[1]));

    await server.start();
    await finished;
    expect(readMessages).toEqual(messages);
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
