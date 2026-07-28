/**
 * Argv-parsing scaffold shared by every `examples/<story>/` pair.
 *
 * Intentionally **zero SDK API calls** in this module — it is pure
 * `process.argv` plumbing plus an assert wrapper. Each story's
 * `server.ts`/`client.ts` shows the real `@modelcontextprotocol/*` calls
 * inline (the canonical shape; see `examples/CONTRIBUTING.md`). This module
 * only DRYs the parts a reader is not here to learn: flag parsing and
 * sibling-path resolution.
 *
 * Re-exported `check` is `node:assert/strict` for readable inline assertions.
 */

import { fileURLToPath } from 'node:url';

export { strict as check } from 'node:assert';

/**
 * Resolve a sibling of the calling module to an absolute filesystem path
 * (`fileURLToPath` handles Windows drive letters and percent-encoded segments,
 * which `new URL(...).pathname` does not). Used by every story's stdio leg to
 * spawn its companion `server.ts` — the path-resolution part of that line is
 * scaffolding, so it lives here rather than being repeated in each `client.ts`.
 */
export function siblingPath(importMetaUrl: string | URL, name: string): string {
    return fileURLToPath(new URL(name, importMetaUrl));
}

export type ExampleTransport = 'stdio' | 'http';
export type ExampleEra = 'modern' | 'legacy';

export interface ExampleArgs {
    /** `'http'` under `--http`, otherwise `'stdio'`. */
    transport: ExampleTransport;
    /** `--port <N>` (or `$PORT`, or 3000) — meaningful on the server side. */
    port: number;
    /** `--http <url>` (or `http://127.0.0.1:<port>/mcp`) — meaningful on the client side. */
    url: string;
    /** `'legacy'` under `--legacy`, otherwise `'modern'` (negotiates 2026-07-28). */
    era: ExampleEra;
}

/**
 * Parse `process.argv` into the four knobs every example branches on.
 *
 * The example runner (`scripts/examples/run-examples.ts`) drives the same
 * binary over each transport/era combination by passing `--http`, `--port`,
 * `--http <url>` and `--legacy`; manual runs use the same flags.
 */
export function parseExampleArgs(defaultPort = 3000): ExampleArgs {
    const argv = process.argv.slice(2);
    const transport: ExampleTransport = argv.includes('--http') ? 'http' : 'stdio';
    const era: ExampleEra = argv.includes('--legacy') ? 'legacy' : 'modern';
    const portIdx = argv.indexOf('--port');
    const port = portIdx === -1 ? Number(process.env.PORT ?? defaultPort) : Number(argv[portIdx + 1]);
    const httpIdx = argv.indexOf('--http');
    // A bare `argv[indexOf('--http') + 1]` reads `argv[0]` (the script path)
    // when the flag is absent, so guard with `httpIdx === -1` first.
    const url = httpIdx === -1 ? `http://127.0.0.1:${port}/mcp` : (argv[httpIdx + 1] ?? `http://127.0.0.1:${port}/mcp`);
    return { transport, port, url, era };
}
