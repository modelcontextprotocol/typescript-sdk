import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { vi } from 'vitest';

import type { StdioServerParameters } from '../../src/client/stdio';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '../../src/client/stdio';

// Configure default server parameters based on OS
// Uses 'more' command for Windows and 'tee' command for Unix/Linux
const getDefaultServerParameters = (): StdioServerParameters => {
    if (process.platform === 'win32') {
        return { command: 'more' };
    }
    return { command: '/usr/bin/tee' };
};

const serverParameters = getDefaultServerParameters();

test('should start then close cleanly', async () => {
    const client = new StdioClientTransport(serverParameters);
    client.onerror = error => {
        throw error;
    };

    let didClose = false;
    client.onclose = () => {
        didClose = true;
    };

    await client.start();
    expect(didClose).toBeFalsy();
    await client.close();
    expect(didClose).toBeTruthy();
});

test('should read messages', async () => {
    const client = new StdioClientTransport(serverParameters);
    client.onerror = error => {
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
        client.onmessage = message => {
            readMessages.push(message);

            if (JSON.stringify(message) === JSON.stringify(messages[1])) {
                resolve();
            }
        };
    });

    await client.start();
    await client.send(messages[0]!);
    await client.send(messages[1]!);
    await finished;
    expect(readMessages).toEqual(messages);

    await client.close();
});

test('should return child process pid', async () => {
    const client = new StdioClientTransport(serverParameters);

    await client.start();
    expect(client.pid).not.toBeNull();
    await client.close();
    expect(client.pid).toBeNull();
});

test('should respect custom maxBufferSize option', async () => {
    const client = new StdioClientTransport({
        command: 'node',
        args: ['-e', 'process.stdout.write(Buffer.alloc(200, 0x41))'],
        maxBufferSize: 100
    });

    const errorReceived = new Promise<Error>(resolve => {
        client.onerror = resolve;
    });
    const closed = new Promise<void>(resolve => {
        client.onclose = () => resolve();
    });

    await client.start();

    const error = await errorReceived;
    expect(error.message).toMatch(/ReadBuffer exceeded maximum size/);
    await closed;
});

test('should fire onerror and close when ReadBuffer overflows', async () => {
    const client = new StdioClientTransport({
        command: 'node',
        args: ['-e', 'process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 0x41))']
    });

    const errorReceived = new Promise<Error>(resolve => {
        client.onerror = resolve;
    });
    const closed = new Promise<void>(resolve => {
        client.onclose = () => resolve();
    });

    await client.start();

    const error = await errorReceived;
    expect(error.message).toMatch(/ReadBuffer exceeded maximum size/);
    await closed;
});

test('_dispose releases the parent-side pipe handles even when a helper process holds the child stdio', async () => {
    // The rmcp-holding anatomy: the child exits, but a helper it spawned with
    // stdio: 'inherit' keeps the pipe write ends open. Awaiting 'exit' settles
    // disposal promptly — but without destroying the PARENT-side handles, the
    // flowing stdout read handle stays ref'd until the helper exits, pinning
    // the host's event loop (indefinitely for a daemon helper).
    const readyFile = `${tmpdir()}/mcp-dispose-ready-${process.pid}-${Date.now()}`;
    const HOLDING_SCRIPT = String.raw`
        const { spawn } = require('child_process');
        spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'inherit' });
        require('fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready');
        process.stdin.on('end', () => process.exit(0));
        process.stdin.resume();
    `;
    const transport = new StdioClientTransport({ command: process.execPath, args: ['-e', HOLDING_SCRIPT] });
    await transport.start();
    // Wait until the grandchild actually exists and holds the inherited pipes
    // — disposing earlier would kill the child before its script even runs.
    while (!existsSync(readyFile)) await new Promise(resolve => setTimeout(resolve, 25));
    const proc = (transport as unknown as { _process: import('node:child_process').ChildProcess })._process;

    await (transport as unknown as { _dispose: () => Promise<void> })._dispose();

    // The child is confirmed gone AND the parent-side handles are released —
    // destroyed flags are the deterministic proxy for "nothing pins the loop".
    expect(proc.stdout?.destroyed).toBe(true);
    expect(proc.stdin?.destroyed).toBe(true);
}, 10_000);

test('close() removes the data listener from stdout to prevent stale reads after close', async () => {
    // Regression test for #780: the 'data' listener on stdout must be removed
    // in close(), otherwise late non-JSON output from the child triggers
    // processReadBuffer() → JSON.parse() → SyntaxError after close.
    const client = new StdioClientTransport({
        command: 'node',
        args: ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));']
    });

    await client.start();

    const proc = (client as unknown as { _process: import('node:child_process').ChildProcess })._process;
    expect(proc).toBeDefined();
    expect(proc.stdout).toBeDefined();

    // Before close, the data listener should be present
    expect(proc.stdout!.listenerCount('data')).toBeGreaterThan(0);

    await client.close();

    // After close, the data listener should be removed
    expect(proc.stdout!.listenerCount('data')).toBe(0);
});

test('send() under back-pressure does not accumulate drain listeners on stdin', async () => {
    // Regression test for #3070: each send() that hits a full stdin buffer used
    // to add its own 'drain' listener, so sustained back-pressure piled them up
    // (MaxListenersExceededWarning). Sends now share a single drain wait.
    const warnings: string[] = [];
    const onWarning = (warning: Error) => {
        if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning.message);
    };
    process.on('warning', onWarning);

    try {
        // A child that never reads stdin keeps the pipe permanently full.
        const client = new StdioClientTransport({
            command: process.execPath,
            args: ['-e', 'setTimeout(() => {}, 10_000)']
        });
        await client.start();

        const pending: Promise<void>[] = [];
        for (let i = 0; i < 30; i++) {
            pending.push(client.send({ jsonrpc: '2.0', id: i, method: 'x', params: { blob: 'a'.repeat(4096) } }));
        }
        await new Promise(resolve => setTimeout(resolve, 100));

        const proc = (client as unknown as { _process: import('node:child_process').ChildProcess })._process;
        expect(proc!.stdin!.listenerCount('drain')).toBeLessThanOrEqual(1);
        expect(warnings).toHaveLength(0);

        await client.close();
        // The back-pressured sends settle once the process is gone (no dangling promises).
        await Promise.all(pending);
    } finally {
        process.off('warning', onWarning);
    }
}, 15_000);

test('close() removes the shared drain listener from stdin when the child never drains', async () => {
    // A back-pressured send() registers the shared 'drain' wait on the child's stdin. If the child
    // is closed before it ever drains, close() (via settlePendingSends()) must remove that listener
    // rather than leave it dangling on a dead stream. A child that never reads stdin keeps the pipe
    // full, so 'drain' never fires on its own — only the explicit removal in close() can clear it.
    const client = new StdioClientTransport({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10_000)']
    });
    await client.start();

    const proc = (client as unknown as { _process: import('node:child_process').ChildProcess })._process;

    // One large back-pressured send registers the shared 'drain' wait on stdin.
    const pending = client.send({ jsonrpc: '2.0', id: 0, method: 'x', params: { blob: 'a'.repeat(256 * 1024) } });
    await vi.waitFor(() => expect(proc!.stdin!.listenerCount('drain')).toBe(1), { timeout: 3000, interval: 25 });

    await client.close();
    await pending;

    // close() settled the pending send and removed the drain listener the dead stdin will never emit.
    expect(proc!.stdin!.listenerCount('drain')).toBe(0);
}, 15_000);

test('a back-pressured send() resolves and onclose fires exactly once when the child dies', async () => {
    // Pins the settle-on-death contract: a send() still waiting on a stdin 'drain' when the child
    // dies resolves (rather than hanging or rejecting), and the connection-gone signal (onclose)
    // fires exactly once. A child that never reads stdin keeps the pipe full, so 'drain' never
    // fires on its own — only the settle-on-death path can resolve the pending send.
    let oncloseCount = 0;
    const client = new StdioClientTransport({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10_000)']
    });
    client.onclose = () => {
        oncloseCount += 1;
    };

    await client.start();

    const proc = (client as unknown as { _process: import('node:child_process').ChildProcess })._process;

    // One large back-pressured send leaves the shared 'drain' wait pending on the full pipe.
    const pending = client.send({ jsonrpc: '2.0', id: 0, method: 'x', params: { blob: 'a'.repeat(256 * 1024) } });
    await vi.waitFor(() => expect(proc!.stdin!.listenerCount('drain')).toBe(1), { timeout: 3000, interval: 25 });

    await client.close();

    // The still-pending send resolves once the child is gone...
    await pending;
    // ...and the connection-gone signal fired exactly once.
    expect(oncloseCount).toBe(1);
}, 15_000);

test('a back-pressured send() still pending when the child exits on its own resolves and onclose fires once', async () => {
    // A child that never reads stdin keeps the pipe full, so a large send() stays pending on the
    // shared 'drain' wait. Here the child exits on its own (not via close()), so the pending send
    // is settled by settle-on-exit (the 'exit' handler) rather than by an explicit close() call —
    // settling at the earliest point the process is gone, so a send can never wait on a 'close'
    // that lags behind exit (e.g. a grandchild inheriting the child's stdio on platforms where
    // 'close' waits for the stdio to fully close). Pins: the send resolves, onclose fires once,
    // and the drain listener the dead stdin will never emit is removed.
    let oncloseCount = 0;
    const client = new StdioClientTransport({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(0), 2000)']
    });
    client.onclose = () => {
        oncloseCount += 1;
    };

    await client.start();

    const proc = (client as unknown as { _process: import('node:child_process').ChildProcess })._process;

    // One large back-pressured send leaves the shared 'drain' wait pending on the full pipe.
    const pending = client.send({ jsonrpc: '2.0', id: 0, method: 'x', params: { blob: 'a'.repeat(256 * 1024) } });
    await vi.waitFor(() => expect(proc!.stdin!.listenerCount('drain')).toBe(1), { timeout: 3000, interval: 25 });

    // The child exits on its own at ~2s; settle-on-exit resolves the send.
    await pending;
    expect(oncloseCount).toBe(1);
    expect(proc!.stdin!.listenerCount('drain')).toBe(0);
}, 15_000);

test('a send() issued after the process has exited but before close rejects as not connected', async () => {
    // Covers the [exited, close-pending] window: the process has exited (exitCode set) but its
    // 'close' event has not fired, so _process is still set. A send() then must reject as not
    // connected (matching the post-close() path) rather than register a drain waiter that only
    // 'close' could settle — which would hang until the grandchild holding the child's stdio goes.
    // exitCode is set manually to hold that state deterministically (on platforms where 'close'
    // lags 'exit' it holds naturally, e.g. a piped child outlived by a grandchild inheriting it).
    let oncloseCount = 0;
    const client = new StdioClientTransport({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10_000)']
    });
    client.onclose = () => {
        oncloseCount += 1;
    };
    await client.start();

    const proc = (client as unknown as { _process: import('node:child_process').ChildProcess })._process;

    (proc! as { exitCode: number | null }).exitCode = 0;
    await expect(client.send({ jsonrpc: '2.0', id: 0, method: 'x', params: {} })).rejects.toThrow('Not connected');

    // Reap the still-running child so 'close' fires; onclose fires exactly once.
    await new Promise<void>(resolve => {
        proc!.once('close', () => resolve());
        proc!.kill('SIGKILL');
    });
    expect(oncloseCount).toBe(1);
}, 15_000);

test('restarting the transport gives the new process a fresh single drain wait', async () => {
    // settlePendingSends() runs on close(), so it empties _pendingDrainWaiters and clears the shared
    // _drainHandler. A transport that is started, saturated, closed, and started again must not
    // carry the old drain wait into the new process's stdin — the new process gets its own single
    // shared wait (no accumulation across the restart).
    const client = new StdioClientTransport({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10_000)']
    });
    await client.start();
    const proc1 = (client as unknown as { _process: import('node:child_process').ChildProcess })._process;
    const pending1 = client.send({ jsonrpc: '2.0', id: 0, method: 'x', params: { blob: 'a'.repeat(256 * 1024) } });
    await vi.waitFor(() => expect(proc1!.stdin!.listenerCount('drain')).toBe(1), { timeout: 3000, interval: 25 });
    await client.close();
    await pending1;

    await client.start();
    const proc2 = (client as unknown as { _process: import('node:child_process').ChildProcess })._process;
    expect(proc2).not.toBe(proc1);
    const pending2 = client.send({ jsonrpc: '2.0', id: 0, method: 'x', params: { blob: 'a'.repeat(256 * 1024) } });
    await vi.waitFor(() => expect(proc2!.stdin!.listenerCount('drain')).toBe(1), { timeout: 3000, interval: 25 });
    expect(proc2!.stdin!.listenerCount('drain')).toBe(1);
    await client.close();
    await pending2;
}, 25_000);

test('close() removes the drain listener the stderr pipe added on the pass-through', async () => {
    // Regression test for #3070. child.stderr.pipe(_stderrStream) attaches a 'drain' listener to
    // _stderrStream (the pipe's destination) once it backs up. A grandchild holding the child's
    // stderr write-end means child.stderr never 'end's, so pipe() never auto-cleans that listener
    // up — close() must unpipe it. Counting 'drain' on the pass-through distinguishes fixed from
    // unfixed; counting it on the source (stderr) would always read 0.
    const HOLDING_SCRIPT = [
        String.raw`const { spawn } = require('child_process');`,
        String.raw`spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { stdio: 'inherit' });`,
        String.raw`process.stderr.write(Buffer.alloc(256 * 1024, 0x41));`
    ].join('\n');
    const client = new StdioClientTransport({
        command: process.execPath,
        args: ['-e', HOLDING_SCRIPT],
        stderr: 'pipe'
    });

    await client.start();

    const stderrStream = (client as unknown as { _stderrStream: import('node:stream').PassThrough })._stderrStream;
    if (stderrStream === null) throw new Error('expected a stderr pass-through');

    // Wait until the child's stderr back-pressure has made pipe() attach the 'drain' listener.
    await vi.waitFor(() => expect(stderrStream.listenerCount('drain')).toBeGreaterThan(0), { timeout: 3000, interval: 25 });

    await client.close();

    // The unpipe in close() removed the drain listener even though the grandchild keeps the
    // child's stderr open, so the pass-through cannot accumulate drain listeners.
    expect(stderrStream.listenerCount('drain')).toBe(0);
}, 20_000);

test('DEFAULT_INHERITED_ENV_VARS matches the host platform', () => {
    if (process.platform === 'win32') {
        // Variables Windows tooling needs to resolve executables and shells.
        // Missing PATHEXT or COMSPEC causes spawn ENOENT for npm/git/etc.
        expect(DEFAULT_INHERITED_ENV_VARS).toEqual(
            expect.arrayContaining([
                'APPDATA',
                'COMSPEC',
                'HOMEDRIVE',
                'HOMEPATH',
                'LOCALAPPDATA',
                'PATH',
                'PATHEXT',
                'PROCESSOR_ARCHITECTURE',
                'PROGRAMDATA',
                'PROGRAMFILES',
                'PROGRAMFILES(X86)',
                'PROGRAMW6432',
                'SYSTEMDRIVE',
                'SYSTEMROOT',
                'TEMP',
                'USERNAME',
                'USERPROFILE',
                'WINDIR'
            ])
        );
    } else {
        expect(DEFAULT_INHERITED_ENV_VARS).toEqual(['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']);
    }
});
