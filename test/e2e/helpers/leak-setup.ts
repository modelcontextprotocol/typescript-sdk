/**
 * Vitest setup: extends the draft-vocabulary leak assertion (draft-leak.ts) to
 * exchanges that bypass `wire()` — the hosting scenarios drive real loopback
 * servers with the global `fetch`, so the harness patches it once per worker.
 *
 * On legacy-era cells every global-fetch exchange is checked for draft-spec
 * (2026-07-28) vocabulary: request headers, JSON request bodies, response
 * headers, and JSON response bodies (streaming responses are checked at the
 * JSON-RPC layer by the wire sniffer instead). Draft-era cells are exempt via
 * the active-cell scope in draft-leak.ts.
 */

import { afterEach } from 'vitest';

import { activeCellIsLegacyEra, assertNoDraftHeaders, assertNoDraftVocabulary, takeRecordedLeaks } from './draft-leak.js';

// A leak thrown deep inside transport plumbing can be swallowed by error
// handling and surface only as a hang/timeout; re-raise the recorded leak so
// the test report carries the real diagnostic (skipped when the test already
// failed with it).
afterEach(context => {
    const leaks = takeRecordedLeaks();
    if (leaks.length === 0) return;
    const alreadyReported = context.task.result?.errors?.some(error => error.message?.includes('[leak]'));
    if (!alreadyReported) throw leaks[0];
});

const PATCHED = Symbol.for('mcp.e2e.draftLeakFetchPatch');

type GlobalWithPatch = typeof globalThis & { [PATCHED]?: boolean };

function tryParseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

if (!(globalThis as GlobalWithPatch)[PATCHED]) {
    (globalThis as GlobalWithPatch)[PATCHED] = true;
    const realFetch = globalThis.fetch;

    globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
        if (!activeCellIsLegacyEra()) return realFetch(input, init);

        const requestHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        assertNoDraftHeaders(requestHeaders, 'client → server HTTP request headers');
        if (typeof init?.body === 'string') {
            const body = tryParseJson(init.body);
            if (body !== undefined) assertNoDraftVocabulary(body, 'client → server HTTP request body');
        }

        const response = await realFetch(input, init);

        assertNoDraftHeaders(response.headers, 'server → client HTTP response headers');
        if ((response.headers.get('content-type') ?? '').includes('application/json')) {
            const body = tryParseJson(await response.clone().text());
            if (body !== undefined) assertNoDraftVocabulary(body, 'server → client HTTP response body');
        }
        return response;
    };
}
