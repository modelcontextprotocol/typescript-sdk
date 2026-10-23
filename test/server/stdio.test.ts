import { Duplex, Readable, Writable } from 'node:stream';
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

test('should fire onclose assigned after start() when stdin was already dead', async () => {
    // The synthetic hangup for a pre-dead stream must land after the caller's
    // start()/connect() continuation — exactly like a real 'end' — otherwise an
    // onclose assigned right after `await server.connect(transport)` never runs.
    input.destroy();
    await new Promise<void>(resolve => {
        input.once('close', resolve);
    });

    const server = new StdioServerTransport(input, output);
    server.onerror = error => {
        throw error;
    };

    await server.start();

    let closeCount = 0;
    const closed = new Promise<void>(resolve => {
        server.onclose = () => {
            closeCount++;
            resolve();
        };
    });

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

test('should remove its stdin end and close listeners on close', async () => {
    // stdin defaults to the process-global process.stdin, so listeners left by a
    // closed transport would pile up across transport lifecycles in one process.
    const server = new StdioServerTransport(input, output);
    await server.start();
    await server.close();

    expect(input.listenerCount('end')).toBe(0);
    expect(input.listenerCount('close')).toBe(0);
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

test('should keep reporting stream errors after stdin ends, until the stream closes', async () => {
    // One duplex for both directions, as with `new StdioServerTransport(socket, socket)`.
    const socket = new Duplex({
        read() {},
        write(_chunk, _encoding, callback) {
            callback();
        }
    });
    const server = new StdioServerTransport(socket, socket);
    const errors: Error[] = [];
    server.onerror = error => errors.push(error);
    const closed = new Promise<void>(resolve => {
        server.onclose = () => resolve();
    });

    await server.start();
    socket.push(null);
    await closed;

    // A pending write can still fail after 'end'; with no listener the process would crash.
    const failure = new Error('write EPIPE');
    socket.emit('error', failure);
    expect(errors).toEqual([failure]);

    socket.destroy();
    await new Promise(resolve => socket.once('close', resolve));
    expect(socket.listenerCount('error')).toBe(0);
});

test('should leave no listeners when close() follows start() on a stream that had already ended', async () => {
    const endedInput = new Readable({ read: () => {}, autoDestroy: false, emitClose: false });
    endedInput.push(null);
    endedInput.resume();
    await new Promise<void>(resolve => {
        endedInput.once('end', resolve);
    });

    const server = new StdioServerTransport(endedInput, output);
    await server.start();
    await server.close();
    // start() deferred its own close by one turn; let it run.
    await new Promise(resolve => setImmediate(resolve));

    expect(endedInput.listenerCount('error')).toBe(0);
    expect(endedInput.listenerCount('close')).toBe(0);
    expect(endedInput.listenerCount('end')).toBe(0);
});
