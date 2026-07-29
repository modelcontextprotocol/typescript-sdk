/**
 * Node-specific fetch dispatcher helpers.
 *
 * On Node 22+, the built-in `fetch` is backed by undici and uses HTTP/2 by
 * default. As of Node 26.4, undici has a stream-buffering regression on SSE
 * over HTTP/2: the initial chunks of an SSE response are buffered and never
 * flushed to the consumer's `ReadableStream`, causing the MCP handshake to
 * hang indefinitely.
 *
 * The fix is to force HTTP/1.1 for SSE traffic. The SDK exposes this as an
 * opt-in via the `nodeDispatcher` option on the transports:
 *
 * ```ts
 * import { Agent } from 'undici';
 * new SSEClientTransport(url, {
 *     nodeDispatcher: new Agent({ allowH2: false }),
 * });
 * ```
 *
 * `createDefaultNodeDispatcher()` returns an HTTP/1.1-only dispatcher on Node
 * 22+ where the bug is reproducible, and `undefined` on other runtimes
 * (browsers, workerd, Node < 22) where the field is ignored or the dispatcher
 * API doesn't exist.
 *
 * The dispatcher is OPT-IN. The SDK does not force HTTP/1.1 by default
 * because:
 * - Most users on Node 22.0–22.x and 23.x do not hit the regression.
 * - Some users explicitly want HTTP/2 for non-SSE traffic.
 * - The default `fetch` behavior should match Node's defaults until users
 *   opt into our hardening.
 */

import type { DispatcherLike } from '@modelcontextprotocol/core-internal';

/**
 * Best-effort importer for `undici.Agent`. Returns `undefined` if undici is
 * not installed (the SDK treats it as a peer dep so consumers opt in).
 */
async function tryImportAgent(): Promise<new (opts: { allowH2?: boolean }) => DispatcherLike | undefined> {
    try {
        // dynamic import is intentional: undici is an optional peer dep
        const mod = (await import('undici' as string)) as { Agent?: new (opts: { allowH2?: boolean }) => DispatcherLike };
        return mod.Agent as new (opts: { allowH2?: boolean }) => DispatcherLike;
    } catch {
        return undefined as unknown as new (opts: { allowH2?: boolean }) => DispatcherLike;
    }
}

/**
 * Returns `true` when the current process is running Node.js 22 or later.
 * Other runtimes (workerd, browser, Node < 22) return `false`.
 */
function isNode22OrLater(): boolean {
    // Default to "true" on unknown runtimes so we err on the side of caution.
    if (typeof process === 'undefined' || !process.versions?.node) return false;
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    return major >= 22;
}

/**
 * Creates an HTTP/1.1-only undici dispatcher for SSE traffic on Node 22+.
 * Returns `undefined` on other runtimes or when undici is missing.
 *
 * The caller is responsible for caching the dispatcher; the SDK does not
 * cache it because the caller decides when to instantiate.
 *
 * Resolution order:
 * 1. If running on Node ≥ 22 AND `undici` is installed, return an
 *    `Agent({ allowH2: false })`. This is the workaround for the Node 26.4
 *    SSE HTTP/2 buffering bug.
 * 2. Otherwise, return `undefined`. The SDK will fall back to the default
 *    fetch.
 */
export async function createDefaultNodeDispatcher(): Promise<DispatcherLike | undefined> {
    if (!isNode22OrLater()) return undefined;
    const Agent = await tryImportAgent();
    if (!Agent) return undefined;
    return new Agent({ allowH2: false });
}

/**
 * Synchronous variant of `createDefaultNodeDispatcher`. Returns `undefined`
 * if undici's `Agent` cannot be resolved (e.g. imported from a non-Node
 * runtime that doesn't expose undici, or used in a context where async
 * resolution is not possible).
 *
 * Most use cases should prefer `createDefaultNodeDispatcher` (async), which
 * has a clear failure mode. This sync variant exists for callers that need
 * a dispatcher at synchronous module-construction time.
 */
export function createDefaultNodeDispatcherSync(): DispatcherLike | undefined {
    if (!isNode22OrLater()) return undefined;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const undici = require('undici' as string) as { Agent?: new (opts: { allowH2?: boolean }) => DispatcherLike };
        const Agent = undici.Agent;
        if (!Agent) return undefined;
        return new Agent({ allowH2: false });
    } catch {
        return undefined;
    }
}
