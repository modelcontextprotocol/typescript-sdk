import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

/**
 * Structural guard for GHSA-345p (cross-tenant routing via id-keyed shared state).
 *
 * The original vulnerability shape was a `Map<RequestId, ...>` (or equivalent) on a
 * long-lived object that routes per-request data. The `dispatch(req, env)` path yields
 * its outputs into a per-call iterator with no id-keyed routing map; this test asserts
 * that property structurally so a future change cannot quietly reintroduce the shape.
 *
 * Intentionally NOT covered: `StreamDriver._responseHandlers` (outbound correlation for
 * requests this side initiates over a persistent channel) is a `Map<RequestId, ...>` but
 * is not in the inbound dispatch path and is not the GHSA shape. `shttpHandler` keys its
 * abort map on `(sessionId, requestId)`, not bare `RequestId`.
 */
describe('GHSA-345p structural guard: no id-keyed maps in inbound dispatch path', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const files = [
        join(here, '../../core/src/shared/dispatcher.ts'),
        join(here, '../src/server/mcp.ts'),
        join(here, '../src/server/shttpHandler.ts')
    ];

    /**
     * Matches the field-declaration shapes that produced GHSA-345p:
     *   `: Map<RequestId, ...>`
     *   `new Map<RequestId, ...>`
     *   `: Map<string | number, ...>` (RequestId's underlying union)
     *   `Record<RequestId, ...>`
     */
    const idKeyedMapPattern = /(?::\s*|new\s+)Map<\s*(?:RequestId|string\s*\|\s*number)\b|Record<\s*RequestId\b/;

    for (const file of files) {
        test(`${file.split('/packages/')[1]} has no Map<RequestId, ...> field declarations`, () => {
            const src = readFileSync(file, 'utf8');
            const matches: string[] = [];
            for (const [i, line] of src.split('\n').entries()) {
                if (idKeyedMapPattern.test(line)) {
                    matches.push(`  ${i + 1}: ${line.trim()}`);
                }
            }
            expect(matches, `id-keyed map declarations found:\n${matches.join('\n')}`).toEqual([]);
        });
    }
});
