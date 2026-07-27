import { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/core-internal';

import { StdioServerTransport } from '../../src/server/stdio';

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

test('should close and fire onclose when stdin ends (client hung up)', async () => {
    // `autoDestroy: false, emitClose: false` so that pushing EOF emits only 'end',
    // proving the 'end' listener works on its own (without relying on 'close').
    const endOnlyInput = new Readable({ read: () => {}, autoDestroy: false, emitClose: false });
    const server = new StdioServerTransport(endOnlyInput, output);
    server.onerror = error => {
        throw error;
    };

    let closeCount = 0;
    const closed = new Promise<void>(resolve => {
        server.onclose = () => {
            closeCount++;
            resolve();
        };
    });

    await server.start();
    endOnlyInput.push(null); // EOF — the client closed its end of the pipe

    await closed;
    expect(closeCount).toBe(1);
});

test('should close and fire onclose when stdin closes', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
        throw error;
    };

    let closeCount = 0;
    const closed = new Promise<void>(resolve => {
        server.onclose = () => {
            closeCount++;
            resolve();
        };
    });

    await server.start();
    input.destroy(); // emits 'close'

    await closed;
    expect(closeCount).toBe(1);
});

test('should fire onclose when stdin was already destroyed before start()', async () => {
    // A custom stream (e.g. a net.Socket the peer reset during async setup) can
    // be dead before start() runs: its one 'close' event already fired, so a
    // listener registered in start() would never see it.
    input.destroy();
    await new Promise<void>(resolve => {
        input.once('close', resolve);
    });
    expect(input.destroyed).toBe(true);

    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
        throw error;
    };

    let closeCount = 0;
    const closed = new Promise<void>(resolve => {
        server.onclose = () => {
            closeCount++;
            resolve();
        };
    });

    await server.start();

    await closed;
    expect(closeCount).toBe(1);
});

test('should fire onclose when stdin had already ended before start()', async () => {
    // `autoDestroy: false, emitClose: false` so consuming the stream to EOF
    // leaves it ended but NOT destroyed — its one 'end' event fired before
    // start(), so only the `readableEnded` check can catch this shape.
    const endedInput = new Readable({ read: () => {}, autoDestroy: false, emitClose: false });
    endedInput.push(null); // EOF
    endedInput.resume(); // flow, so 'end' actually fires
    await new Promise<void>(resolve => {
        endedInput.once('end', resolve);
    });
    expect(endedInput.readableEnded).toBe(true);
    expect(endedInput.destroyed).toBe(false);

    const server = new StdioServerTransport(endedInput, output);
    server.onerror = error => {
        throw error;
    };

    let closeCount = 0;
    const closed = new Promise<void>(resolve => {
        server.onclose = () => {
            closeCount++;
            resolve();
        };
    });

    await server.start();

    await closed;
    expect(closeCount).toBe(1);
});

test('should not fire onclose twice when close() is called after stdin ends', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
        throw error;
    };

    let closeCount = 0;
    const closed = new Promise<void>(resolve => {
        server.onclose = () => {
            closeCount++;
            resolve();
        };
    });

    await server.start();
    input.push(null); // EOF fires 'end', and stream teardown may fire 'close' too

    await closed;
    await server.close();
    // Allow any late 'close' event from the stream teardown to be delivered
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(closeCount).toBe(1);
});

test('should still deliver messages that arrived before stdin ended', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
        throw error;
    };

    const messages: JSONRPCMessage[] = [];
    const closed = new Promise<void>(resolve => {
        server.onclose = () => resolve();
    });
    server.onmessage = message => {
        messages.push(message);
    };

    const message: JSONRPCMessage = { jsonrpc: '2.0', id: 1, method: 'ping' };
    input.push(serializeMessage(message));
    input.push(null); // EOF right behind the message

    await server.start();
    await closed;

    expect(messages).toEqual([message]);
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
    // send()'s per-send listeners are cleaned up; only the transport's own 'error'
    // listener remains — the stdout error triggered close(), which keeps it
    // attached (as a no-op) to swallow late write failures.
    expect(slowOutput.listenerCount('error')).toBe(1);
});

test('should swallow stdout errors that surface after close (late EPIPE from a pending write)', async () => {
    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
        throw error;
    };

    const closed = new Promise<void>(resolve => {
        server.onclose = () => resolve();
    });

    await server.start();

    // Fast-path send: write() returns true, so the per-send 'error' listener is
    // detached immediately — but the OS-level write may still be pending.
    await server.send({ jsonrpc: '2.0', id: 1, method: 'ping' });

    // The client hangs up: stdin EOF closes the transport.
    input.push(null);
    await closed;

    // The pending write now fails (e.g. EPIPE because the client's read end is
    // gone). If stdout had no 'error' listener left, this emit would throw
    // ERR_UNHANDLED_ERROR — in a real process, an uncaught exception and exit 1.
    expect(() => output.emit('error', new Error('write EPIPE'))).not.toThrow();
});

test('repeated create→close cycles on shared streams should not accumulate stdout listeners', async () => {
    // _stdin/_stdout default to the process-global process.stdin/process.stdout, so
    // any listener a closed transport leaves behind would pile up across transport
    // lifecycles in one process (MaxListenersExceededWarning after 11 cycles). Use
    // fake shared streams to model that without touching the real process streams.
    const sharedInput = new Readable({ read: () => {} });
    const sharedOutput = new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        }
    });

    for (let cycle = 0; cycle < 2; cycle++) {
        const server = new StdioServerTransport(sharedInput, sharedOutput);
        await server.start();
        await server.close();

        // Exactly one 'error' listener stays behind after each cycle — the closed
        // transport's swallow-only listener — and it is swept when the next
        // transport starts, so the count never grows across cycles.
        expect(sharedOutput.listenerCount('error')).toBe(1);
    }

    // The leftover listener still swallows late write failures from pending writes.
    expect(() => sharedOutput.emit('error', new Error('write EPIPE'))).not.toThrow();
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
