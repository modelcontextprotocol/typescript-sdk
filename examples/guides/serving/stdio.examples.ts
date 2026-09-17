/**
 * Runnable, type-checked companion for `docs/serving/stdio.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's `ts` fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift). The regions
 * are one linear stdio server program. The file runs in two modes:
 *
 *   - `node --import tsx stdio.examples.ts --serve` — be that stdio server, plus
 *     the one deliberate `console.log` the page's gotcha section describes, and
 *     stay alive on stdin like any stdio server.
 *   - `node --import tsx stdio.examples.ts` (default) — the harness: spawn this
 *     file with `--serve`, send it an `initialize` request, and print every line
 *     the child wrote to each of its streams. The page quotes that output
 *     verbatim; the harness exits non-zero if the corruption it demonstrates
 *     ever stops being observable.
 *
 * @module
 */
/* eslint-disable no-console */

//#region serveStdio_basic
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const handle = serveStdio(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    // server.registerTool(...) — one factory builds the instance that serves the connection
    return server;
});
//#endregion serveStdio_basic

//#region serveStdio_logStderr
console.error('notes server is listening on stdio');
//#endregion serveStdio_logStderr

//#region serveStdio_shutdown
process.on('SIGINT', () => {
    void handle.close();
});
//#endregion serveStdio_shutdown

// ---------------------------------------------------------------------------
// Harness (not shown on the page).
//
// `--serve` mode: the regions above already made this process a real stdio
// server. Inject the page's gotcha — one `console.log` on the protocol channel
// — and stay alive on stdin (the spawning harness kills the child when done).
//
// Default mode: spawn this file with `--serve`, write a JSON-RPC `initialize`
// request to the child's stdin, then print every line the child wrote to each
// stream. "Log to stderr, never stdout" quotes this output verbatim.
// ---------------------------------------------------------------------------

if (process.argv.includes('--serve')) {
    // The bug the page demonstrates: one log line written to stdout.
    console.log('debug: starting the notes server');
} else {
    const { spawn } = await import('node:child_process');
    const { dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const selfPath = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, ['--no-warnings', '--import', 'tsx', selfPath, '--serve'], {
        cwd: dirname(selfPath)
    });

    let childStdout = '';
    let childStderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
        childStdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
        childStderr += chunk;
    });

    // What an MCP host writes first: the `initialize` request, one JSON line on stdin.
    child.stdin.write(
        `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'host', version: '1.0.0' } }
        })}\n`
    );

    // Wait for the `initialize` response to reach the child's stdout, then stop the child.
    const deadline = Date.now() + 30_000;
    while (!childStdout.includes('"id":1') && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));

    const stdoutLines = childStdout.trimEnd().split('\n');
    const stderrLines = childStderr.trimEnd().split('\n');
    for (const line of stdoutLines) console.log(`[stdout] ${line}`);
    for (const line of stderrLines) console.log(`[stderr] ${line}`);

    // Self-verification — the page's claims must stay observable, or this exits non-zero.
    if (stdoutLines[0] !== 'debug: starting the notes server') {
        throw new Error(`expected the stray console.log first on stdout, got ${JSON.stringify(stdoutLines)}`);
    }
    if (!stdoutLines[1]?.includes('"jsonrpc":"2.0"')) {
        throw new Error(`expected the initialize response next on stdout, got ${JSON.stringify(stdoutLines)}`);
    }
    if (!stderrLines.includes('notes server is listening on stdio')) {
        throw new Error(`expected the console.error banner on stderr, got ${JSON.stringify(stderrLines)}`);
    }

    await handle.close();
    // The regions above also started a real stdio server on this process; end it here.
    // eslint-disable-next-line unicorn/no-process-exit
    process.exit(0);
}
