import { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import {
    DRAFT_PROTOCOL_VERSION,
    PROTOCOL_VERSION_META_KEY,
    ReadBuffer,
    serializeMessage,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';
import { vi } from 'vitest';

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

// ───── stateless routing (draft protocol revisions) ─────

/** A request claiming `version` per-request via `params._meta` — the stdio routing signal. */
function versionClaimingRequest(id: number, version: string): JSONRPCMessage {
    return { jsonrpc: '2.0', id, method: 'tools/list', params: { _meta: { [PROTOCOL_VERSION_META_KEY]: version } } };
}

const DRAFT_LISTED = [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION];

/** Waits for the next JSON-RPC message the transport writes to stdout. */
async function nextStdoutMessage(): Promise<JSONRPCMessage> {
    return await vi.waitFor(() => {
        const message = outputBuffer.readMessage();
        if (message === null) {
            throw new Error('no message written to stdout yet');
        }
        return message;
    });
}

test('sends the dispatch result for a routed request on stdout', async () => {
    const server = new StdioServerTransport(input, output);
    const dispatch = vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 3, result: { ok: true } });
    server.setStatelessHandlers({ dispatch });
    server.setSupportedProtocolVersions(DRAFT_LISTED);
    const onmessage = vi.fn();
    server.onmessage = onmessage;
    server.onerror = error => {
        throw error;
    };

    await server.start();
    const request = versionClaimingRequest(3, DRAFT_PROTOCOL_VERSION);
    input.push(serializeMessage(request));

    expect(await nextStdoutMessage()).toEqual({ jsonrpc: '2.0', id: 3, result: { ok: true } });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(request, {
        signal: expect.any(AbortSignal),
        sendNotification: expect.any(Function)
    });
    expect(onmessage).not.toHaveBeenCalled();
});

test('writes notifications the dispatch emits to stdout before the response', async () => {
    const server = new StdioServerTransport(input, output);
    server.setStatelessHandlers({
        dispatch: async (request, ctx) => {
            await ctx.sendNotification?.({
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: { progressToken: 'tok', progress: 1 }
            });
            return { jsonrpc: '2.0', id: request.id, result: {} };
        }
    });
    server.setSupportedProtocolVersions(DRAFT_LISTED);
    server.onerror = error => {
        throw error;
    };

    await server.start();
    input.push(serializeMessage(versionClaimingRequest(4, DRAFT_PROTOCOL_VERSION)));

    expect(await nextStdoutMessage()).toEqual({
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'tok', progress: 1 }
    });
    expect(await nextStdoutMessage()).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
});

test('leaves stateful-version, meta-less, and notification traffic on onmessage', async () => {
    const server = new StdioServerTransport(input, output);
    const dispatch = vi.fn();
    server.setStatelessHandlers({ dispatch });
    server.setSupportedProtocolVersions(DRAFT_LISTED);
    server.onerror = error => {
        throw error;
    };

    const messages: JSONRPCMessage[] = [
        // A stateful-version claim never routes, even though the version is listed.
        versionClaimingRequest(1, '2025-06-18'),
        // No claim at all: today's traffic, untouched.
        { jsonrpc: '2.0', id: 2, method: 'ping' },
        // Only requests route: a notification claiming a listed draft version stays on onmessage.
        {
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: { _meta: { [PROTOCOL_VERSION_META_KEY]: DRAFT_PROTOCOL_VERSION } }
        }
    ];

    const received: JSONRPCMessage[] = [];
    server.onmessage = message => received.push(message);

    await server.start();
    for (const message of messages) {
        input.push(serializeMessage(message));
    }

    await vi.waitFor(() => expect(received).toHaveLength(3));
    expect(received).toEqual(messages);
    expect(dispatch).not.toHaveBeenCalled();
    expect(outputBuffer.readMessage()).toBeNull();
});

test('a stateless-version claim falls through to onmessage when no handlers are installed', async () => {
    const server = new StdioServerTransport(input, output);
    server.setSupportedProtocolVersions(DRAFT_LISTED);
    server.onerror = error => {
        throw error;
    };

    const received: JSONRPCMessage[] = [];
    server.onmessage = message => received.push(message);

    await server.start();
    const request = versionClaimingRequest(5, DRAFT_PROTOCOL_VERSION);
    input.push(serializeMessage(request));

    await vi.waitFor(() => expect(received).toEqual([request]));
    expect(outputBuffer.readMessage()).toBeNull();
});

test('a stateless-version claim falls through to onmessage when the server has not opted in', async () => {
    const server = new StdioServerTransport(input, output);
    const dispatch = vi.fn();
    server.setStatelessHandlers({ dispatch });
    // Default supported list: no non-stateful version listed, so the claim never routes.
    server.onerror = error => {
        throw error;
    };

    const received: JSONRPCMessage[] = [];
    server.onmessage = message => received.push(message);

    await server.start();
    const request = versionClaimingRequest(6, DRAFT_PROTOCOL_VERSION);
    input.push(serializeMessage(request));

    await vi.waitFor(() => expect(received).toEqual([request]));
    expect(dispatch).not.toHaveBeenCalled();
    expect(outputBuffer.readMessage()).toBeNull();
});

test('an unlisted non-stateful claim still routes on an opted-in server', async () => {
    // The opt-in is listing any non-stateful version; the dispatch then answers
    // unlisted claims with -32004 (here doubled, so only routing is under test).
    const server = new StdioServerTransport(input, output);
    const dispatch = vi
        .fn()
        .mockResolvedValue({ jsonrpc: '2.0', id: 7, error: { code: -32_004, message: 'Unsupported protocol version' } });
    server.setStatelessHandlers({ dispatch });
    server.setSupportedProtocolVersions(DRAFT_LISTED);
    const onmessage = vi.fn();
    server.onmessage = onmessage;
    server.onerror = error => {
        throw error;
    };

    await server.start();
    const request = versionClaimingRequest(7, 'v999.0.0');
    input.push(serializeMessage(request));

    expect(await nextStdoutMessage()).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32_004, message: 'Unsupported protocol version' } });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(request, {
        signal: expect.any(AbortSignal),
        sendNotification: expect.any(Function)
    });
    expect(onmessage).not.toHaveBeenCalled();
});

test('a dispatch rejection answers with a generic internal error (no leak)', async () => {
    const server = new StdioServerTransport(input, output);
    server.setStatelessHandlers({
        dispatch: () => {
            throw new Error('secret internal detail');
        }
    });
    server.setSupportedProtocolVersions(DRAFT_LISTED);
    const errors: Error[] = [];
    server.onerror = error => errors.push(error);

    await server.start();
    input.push(serializeMessage(versionClaimingRequest(9, DRAFT_PROTOCOL_VERSION)));

    // The wire gets a generic message (no internal details leak); onerror gets the real one.
    expect(await nextStdoutMessage()).toEqual({ jsonrpc: '2.0', id: 9, error: { code: -32_603, message: 'Internal error' } });
    expect(errors.map(error => error.message)).toEqual(['secret internal detail']);
});

// ───── stateless cancellation (notifications/cancelled for in-flight dispatches) ─────

/** A `notifications/cancelled` for the given request id. */
function cancelledNotification(requestId: number | string): JSONRPCMessage {
    return { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } };
}

test('notifications/cancelled aborts an in-flight stateless dispatch and suppresses every later frame', async () => {
    const server = new StdioServerTransport(input, output);
    let dispatchCtxSignal: AbortSignal | undefined;
    let release: () => void;
    const released = new Promise<void>(resolve => {
        release = resolve;
    });
    server.setStatelessHandlers({
        dispatch: async (request, ctx) => {
            dispatchCtxSignal = ctx.signal;
            await released;
            // Late notification and response after the abort: neither may reach stdout.
            await ctx.sendNotification?.({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 't', progress: 1 } });
            return { jsonrpc: '2.0', id: request.id, result: { late: true } };
        }
    });
    server.setSupportedProtocolVersions(DRAFT_LISTED);
    const onmessage = vi.fn();
    server.onmessage = onmessage;
    server.onerror = error => {
        throw error;
    };

    await server.start();
    input.push(serializeMessage(versionClaimingRequest(11, DRAFT_PROTOCOL_VERSION)));
    await vi.waitFor(() => expect(dispatchCtxSignal).toBeDefined());
    expect(dispatchCtxSignal!.aborted).toBe(false);

    input.push(serializeMessage(cancelledNotification(11)));
    await vi.waitFor(() => expect(dispatchCtxSignal!.aborted).toBe(true));

    release!();
    // Drain a macrotask so the dispatch settles, then assert silence.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(outputBuffer.readMessage()).toBeNull();
    // The cancellation was consumed by the stateless path, never forwarded.
    expect(onmessage).not.toHaveBeenCalled();
});

test('notifications/cancelled for ids with no in-flight stateless dispatch stays on onmessage', async () => {
    const server = new StdioServerTransport(input, output);
    const dispatch = vi.fn().mockResolvedValue({ jsonrpc: '2.0', id: 12, result: {} });
    server.setStatelessHandlers({ dispatch });
    server.setSupportedProtocolVersions(DRAFT_LISTED);
    const received: JSONRPCMessage[] = [];
    server.onmessage = message => received.push(message);
    server.onerror = error => {
        throw error;
    };

    await server.start();
    // A completed stateless request: its map entry is gone by the time the cancel arrives.
    input.push(serializeMessage(versionClaimingRequest(12, DRAFT_PROTOCOL_VERSION)));
    expect(await nextStdoutMessage()).toEqual({ jsonrpc: '2.0', id: 12, result: {} });

    const lateCancel = cancelledNotification(12);
    const statefulCancel = cancelledNotification(99);
    input.push(serializeMessage(lateCancel));
    input.push(serializeMessage(statefulCancel));

    // Both cancellations belong to the connection-scoped protocol instance.
    await vi.waitFor(() => expect(received).toEqual([lateCancel, statefulCancel]));
});
