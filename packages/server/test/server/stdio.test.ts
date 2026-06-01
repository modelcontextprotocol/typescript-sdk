import { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import {
    DRAFT_PROTOCOL_VERSION_2026,
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

const DRAFT_LISTED = [...SUPPORTED_PROTOCOL_VERSIONS, DRAFT_PROTOCOL_VERSION_2026];

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
    const request = versionClaimingRequest(3, DRAFT_PROTOCOL_VERSION_2026);
    input.push(serializeMessage(request));

    expect(await nextStdoutMessage()).toEqual({ jsonrpc: '2.0', id: 3, result: { ok: true } });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(request, {});
    expect(onmessage).not.toHaveBeenCalled();
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
            params: { _meta: { [PROTOCOL_VERSION_META_KEY]: DRAFT_PROTOCOL_VERSION_2026 } }
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
    const request = versionClaimingRequest(5, DRAFT_PROTOCOL_VERSION_2026);
    input.push(serializeMessage(request));

    await vi.waitFor(() => expect(received).toEqual([request]));
    expect(outputBuffer.readMessage()).toBeNull();
});

test('a non-NotImplementedYetError dispatch failure answers with a generic internal error', async () => {
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
    input.push(serializeMessage(versionClaimingRequest(9, DRAFT_PROTOCOL_VERSION_2026)));

    // The wire gets a generic message (no internal details leak); onerror gets the real one.
    expect(await nextStdoutMessage()).toEqual({ jsonrpc: '2.0', id: 9, error: { code: -32_603, message: 'Internal error' } });
    expect(errors.map(error => error.message)).toEqual(['secret internal detail']);
});
