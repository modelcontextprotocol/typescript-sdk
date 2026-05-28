/**
 * Self-contained test bodies for the real spawned-process stdio transport.
 *
 * Unlike other scenario areas these do not use `wire()`: every body spawns the
 * fixture server in `fixtures/stdio-server.ts` as a real child process via
 * {@link StdioClientTransport}, so the matrix `transport` arg is ignored and
 * the requirements should list `transports: ['stdio']` only. Each body closes
 * the transport in a `finally` so no child process outlives the test.
 *
 * Function names mirror the requirement id in camelCase.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, vi } from 'vitest';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client } from '@modelcontextprotocol/client';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/core';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

/** Absolute path to the runnable fixture server (executed with tsx). */
const FIXTURE_PATH = fileURLToPath(new URL('../fixtures/stdio-server.ts', import.meta.url));

/** Repo root — used as the spawn cwd so `npx`/node resolve the workspace-local `tsx`. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Plain client with no extra capabilities declared. */
const newClient = () => new Client({ name: 'c', version: '0' });

/** True while `pid` refers to a live process (signal 0 probes existence only). */
function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** Asserts a raw wire capture is one JSON-RPC message per line (newline count == message count) and returns the lines. */
function expectOneMessagePerLine(raw: string): string[] {
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.slice(0, -1).split('\n');
    const messages = lines.map(line => JSONRPCMessageSchema.parse(JSON.parse(line)));
    const newlineCount = raw.split('\n').length - 1;
    expect(messages).toHaveLength(newlineCount);
    return lines;
}

verifies('transport:stdio:clean-shutdown', async (_args: TestArgs) => {
    // Direct spawn (not npx) so transport.pid IS the server, with a thin wrapper
    // logging stderr markers: the exit path is observed (stdin EOF seen, no
    // SIGTERM delivered) instead of inferred from a wall-clock bound.
    const wrapperScript = [
        `process.on('SIGTERM', () => { process.stderr.write('[wrapper] sigterm received\\n'); process.exit(143); });`,
        `process.stdin.on('end', () => { process.stderr.write('[wrapper] stdin eof\\n'); });`,
        `await import(${JSON.stringify(pathToFileURL(FIXTURE_PATH).href)});`
    ].join('\n');
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', '--input-type=module', '-e', wrapperScript],
        cwd: REPO_ROOT,
        stderr: 'pipe'
    });
    const stderr = transport.stderr;
    if (stderr === null) throw new Error('expected transport.stderr when spawned with stderr: "pipe"');
    let captured = '';
    stderr.on('data', (chunk: Buffer) => {
        captured += chunk.toString();
    });

    const client = newClient();
    let sawClose = false;
    client.onclose = () => {
        sawClose = true;
    };

    try {
        await client.connect(transport);
        const childPid = transport.pid;
        if (childPid === null) throw new Error('expected a child pid after connect');
        expect(processAlive(childPid)).toBe(true);

        const echoed = await client.callTool({ name: 'echo', arguments: { text: 'shutting down soon' } });
        expect(echoed.isError).toBeFalsy();
        expect(echoed.content).toEqual([{ type: 'text', text: 'shutting down soon' }]);

        // close() ends the child's stdin; a well-behaved server exits on EOF alone.
        await client.close();

        expect(sawClose).toBe(true);
        expect(processAlive(childPid)).toBe(false);
        await vi.waitFor(() => expect(captured).toContain('[wrapper] stdin eof'), { timeout: 2_000, interval: 25 });
        // Exit came from the EOF path, not the SIGTERM/SIGKILL escalation ladder.
        expect(captured).not.toContain('[wrapper] sigterm received');
    } finally {
        await transport.close();
    }
});

verifies('transport:stdio:no-embedded-newlines', async (_args: TestArgs) => {
    const payload = [
        'first line',
        'second line with a carriage return\r',
        '',
        '{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{}}',
        'last line',
        ''
    ].join('\n');

    // Tee wrapper between client and fixture: appends each direction's raw bytes
    // to a capture file (synchronously, before forwarding) so the serialized wire
    // framing itself is observable, not just the content round-trip.
    const captureDir = await mkdtemp(join(tmpdir(), 'stdio-wire-'));
    const clientToServerPath = join(captureDir, 'client-to-server.jsonl');
    const serverToClientPath = join(captureDir, 'server-to-client.jsonl');
    const teeScript = [
        `import { spawn } from 'node:child_process';`,
        `import { appendFileSync } from 'node:fs';`,
        `const child = spawn(process.execPath, ['--import', 'tsx', ${JSON.stringify(FIXTURE_PATH)}], { stdio: ['pipe', 'pipe', 'inherit'] });`,
        `process.stdin.on('data', c => { appendFileSync(${JSON.stringify(clientToServerPath)}, c); child.stdin.write(c); });`,
        `process.stdin.on('end', () => child.stdin.end());`,
        `child.stdout.on('data', c => { appendFileSync(${JSON.stringify(serverToClientPath)}, c); process.stdout.write(c); });`,
        `child.on('exit', code => process.exit(code === null ? 1 : code));`
    ].join('\n');

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--input-type=module', '-e', teeScript],
        cwd: REPO_ROOT
    });
    const client = newClient();
    try {
        await client.connect(transport);

        // Round-trip sanity check: the multi-line payload survives intact.
        const echoed = await client.callTool({ name: 'echo', arguments: { text: payload } });
        expect(echoed.isError).toBeFalsy();
        expect(echoed.content).toEqual([{ type: 'text', text: payload }]);

        const after = await client.callTool({ name: 'echo', arguments: { text: 'still framed' } });
        expect(after.content).toEqual([{ type: 'text', text: 'still framed' }]);

        // Captures are complete once the calls above resolved (bytes are written
        // to disk before being forwarded), so read them before close().
        const clientLines = expectOneMessagePerLine(await readFile(clientToServerPath, 'utf8'));
        const serverLines = expectOneMessagePerLine(await readFile(serverToClientPath, 'utf8'));

        // initialize, notifications/initialized, two tools/call ↔ three responses.
        expect(clientLines).toHaveLength(4);
        expect(serverLines).toHaveLength(3);

        // The newline-riddled payload crossed each direction inside exactly one
        // line, escaped — never split across lines.
        const escapedPayload = JSON.stringify(payload);
        expect(clientLines.filter(line => line.includes(escapedPayload))).toHaveLength(1);
        expect(serverLines.filter(line => line.includes(escapedPayload))).toHaveLength(1);
    } finally {
        await transport.close();
        await rm(captureDir, { recursive: true, force: true });
    }
});

verifies('transport:stdio:shutdown-escalation', async (_args: TestArgs) => {
    // Spawned directly (`node --import tsx`) instead of via `npx tsx`: close()
    // signals the process the transport spawned, and behind npx the SIGTERM/
    // SIGKILL escalation would only ever reach the npx wrapper while the real
    // server — which ignores SIGTERM — survived as an orphan. Direct spawn makes
    // the spawned process BE the server so the full ladder is observable.
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', FIXTURE_PATH],
        cwd: REPO_ROOT,
        env: { E2E_IGNORE_SIGTERM: '1' },
        stderr: 'pipe'
    });
    const stderr = transport.stderr;
    if (stderr === null) throw new Error('expected transport.stderr when spawned with stderr: "pipe"');
    let captured = '';
    stderr.on('data', (chunk: Buffer) => {
        captured += chunk.toString();
    });

    const client = newClient();
    let childPid: number | null = null;
    try {
        await client.connect(transport);
        childPid = transport.pid;
        if (childPid === null) throw new Error('expected a child pid after connect');
        const pid = childPid;
        expect(processAlive(pid)).toBe(true);

        const echoed = await client.callTool({ name: 'echo', arguments: { text: 'about to ignore shutdown' } });
        expect(echoed.content).toEqual([{ type: 'text', text: 'about to ignore shutdown' }]);

        // The fixture survives stdin EOF and swallows SIGTERM, so close() must
        // walk the whole escalation ladder (two grace periods, ~4s wall clock).
        await client.close();

        // SIGTERM really was delivered and ignored — surviving rung 1 (stdin
        // EOF) and rung 2 (SIGTERM) is proven by the marker, so the child's
        // termination below can only have come from the SIGKILL escalation.
        await vi.waitFor(() => expect(captured).toContain('[stdio-server] sigterm ignored'), { timeout: 1_000, interval: 25 });
        await vi.waitFor(() => expect(processAlive(pid)).toBe(false), { timeout: 2_000, interval: 25 });
    } finally {
        await transport.close();
        // Belt and braces: if an assertion threw mid-ladder the stubborn child
        // may still be alive and must not outlive the test run.
        if (childPid !== null && processAlive(childPid)) {
            process.kill(childPid, 'SIGKILL');
        }
    }
});

verifies('transport:stdio:stderr-passthrough', async (_args: TestArgs) => {
    const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', FIXTURE_PATH], cwd: REPO_ROOT, stderr: 'pipe' });

    // With stderr: 'pipe' the stream is available before start(), so listeners
    // attached here cannot miss output written while the server boots.
    const stderr = transport.stderr;
    if (stderr === null) throw new Error('expected transport.stderr when spawned with stderr: "pipe"');
    let captured = '';
    stderr.on('data', (chunk: Buffer) => {
        captured += chunk.toString();
    });

    const client = newClient();
    try {
        await client.connect(transport);

        // The startup marker the server wrote to stderr is observable on
        // transport.stderr — the transport neither swallows it nor mixes it
        // into the stdout JSON-RPC channel.
        await vi.waitFor(() => expect(captured).toContain('[stdio-server] ready'), { timeout: 2_000, interval: 25 });

        // ...and stderr output does not disturb the JSON-RPC channel itself.
        const echoed = await client.callTool({ name: 'echo', arguments: { text: 'hello over stdio' } });
        expect(echoed.isError).toBeFalsy();
        expect(echoed.content).toEqual([{ type: 'text', text: 'hello over stdio' }]);
    } finally {
        await transport.close();
    }
});

verifies('lifecycle:connect:onerror-pre-handshake', async (_args: TestArgs) => {
    // Requirement: 'Transport errors emitted after transport.start() but before
    // client.connect() resolves are delivered to a client.onerror handler set
    // prior to connect (Protocol wires transport.onerror before start() and
    // before the initialize handshake).'
    //
    // Spawn the fixture with E2E_GARBAGE_STDOUT=1: it writes non-JSON garbage to
    // stdout immediately (before the handshake) and exits. The garbage fails to
    // parse, triggering transport.onerror. Assert that client.onerror fires and
    // that connect() does not hang or falsely succeed.

    const transport = new StdioClientTransport({
        command: 'npx',
        args: ['tsx', FIXTURE_PATH],
        cwd: REPO_ROOT,
        env: { E2E_GARBAGE_STDOUT: '1' }
    });

    const client = newClient();
    const errors: Error[] = [];
    client.onerror = (error: Error) => {
        errors.push(error);
    };

    try {
        // connect() should either reject (because the handshake never completes)
        // or hang until timeout. We bound the whole test well under 10s by racing
        // with a short timeout, ensuring we don't wait forever if the SDK
        // incorrectly succeeds or hangs.
        const connectPromise = client.connect(transport);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('connect timed out (expected behavior)')), 8_000)
        );

        await expect(Promise.race([connectPromise, timeoutPromise])).rejects.toThrow();

        // At this point, client.onerror should have fired at least once due to
        // the garbage JSON parse failures.
        expect(errors.length).toBeGreaterThan(0);

        // At least one error should relate to JSON parsing of the garbage lines.
        const hasJsonError = errors.some(
            e => e.message.includes('JSON') || e.message.includes('parse') || e.message.includes('Unexpected token')
        );
        expect(hasJsonError).toBe(true);
    } finally {
        await transport.close();
    }
});

verifies('transport:stdio:default-env-safelist', async (_args: TestArgs) => {
    // Requirement: 'StdioClientTransport spawned with no `env` option passes
    // only DEFAULT_INHERITED_ENV_VARS (PATH, HOME, USER, …) to the child;
    // arbitrary parent process.env entries (secrets) are not inherited.
    // getDefaultEnvironment() is the public helper that produces this safelist.'
    //
    // Set a sentinel env var in the parent for the duration of this test, spawn
    // the fixture WITHOUT passing env (so getDefaultEnvironment() is applied),
    // call the env-report tool to see which variable NAMES reached the child,
    // then assert the sentinel is NOT present while expected safelisted vars are.

    const SENTINEL_KEY = 'E2E_SECRET_SENTINEL';
    const originalValue = process.env[SENTINEL_KEY];
    process.env[SENTINEL_KEY] = 'should-not-reach-child';

    const transport = new StdioClientTransport({
        command: 'npx',
        args: ['tsx', FIXTURE_PATH],
        cwd: REPO_ROOT
        // Deliberately omit `env` option, so getDefaultEnvironment() applies.
    });

    const client = newClient();
    try {
        await client.connect(transport);

        // Call env-report tool: returns JSON.stringify(Object.keys(process.env).sort()).
        const result = await client.callTool({ name: 'env-report', arguments: {} });
        expect(result.isError).toBeFalsy();
        if (!result.content || !Array.isArray(result.content)) {
            throw new Error('expected content array from env-report');
        }
        expect(result.content).toHaveLength(1);
        const firstContent = result.content[0];
        if (!firstContent || firstContent.type !== 'text') {
            throw new Error('expected text content from env-report');
        }
        const childEnvKeys: string[] = JSON.parse(firstContent.text);

        // The sentinel must NOT be present in the child.
        expect(childEnvKeys).not.toContain(SENTINEL_KEY);

        // At least one safelisted variable (from DEFAULT_INHERITED_ENV_VARS)
        // should be present. We pick variables that are very likely to exist
        // on any platform the test runs on.
        const expectedKeys = process.platform === 'win32' ? ['PATH', 'SYSTEMROOT'] : ['PATH', 'HOME'];
        for (const key of expectedKeys) {
            // Only assert presence if the parent has it (some minimal containers might lack HOME).
            if (process.env[key] !== undefined) {
                expect(childEnvKeys).toContain(key);
            }
        }
    } finally {
        await transport.close();
        // Restore original env state.
        if (originalValue === undefined) {
            delete process.env[SENTINEL_KEY];
        } else {
            process.env[SENTINEL_KEY] = originalValue;
        }
    }
});
