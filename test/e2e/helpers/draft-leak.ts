/**
 * Negative leak assertion: draft-spec (2026-07-28) vocabulary must not appear
 * on 2025-era exchanges.
 *
 * The negative set lives in `draft-vocabulary.ts`, derived from the spec
 * sources by `scripts/generate-draft-vocabulary.ts` (never hand-listed). The
 * harness applies the assertion to every raw wire exchange of a legacy-era
 * cell: the wire sniffer checks every JSON-RPC message in both directions, and
 * the HTTP legs additionally check request/response headers. Draft-era cells
 * (and tests that deliberately exercise draft vocabulary) are exempt via
 * {@link runWithCellSpecVersion} / the sniffer's `allowDraftVocabulary` option.
 *
 * Checked per message:
 * - object keys anywhere in the tree that are draft-only field names or
 *   draft-only reserved `_meta` keys (there is deliberately no bare
 *   `io.modelcontextprotocol/*` wildcard — `related-task` and
 *   extension-identifier keys are normative 2025-11-25 vocabulary);
 * - `code` members carrying a draft-only JSON-RPC error code;
 * - string values containing a draft-only protocol revision.
 */

import type { SpecVersion } from '../types.js';
import {
    DRAFT_ONLY_ERROR_CODES,
    DRAFT_ONLY_FIELD_NAMES,
    DRAFT_ONLY_HEADER_NAMES,
    DRAFT_ONLY_HEADER_PREFIXES,
    DRAFT_ONLY_META_KEYS,
    DRAFT_ONLY_PROTOCOL_VERSIONS
} from './draft-vocabulary.js';

const DRAFT_KEYS = new Set<string>([...DRAFT_ONLY_FIELD_NAMES, ...DRAFT_ONLY_META_KEYS]);
const DRAFT_ERROR_CODES = new Set<number>(DRAFT_ONLY_ERROR_CODES);

export function isDraftSpecVersion(version: string): boolean {
    return (DRAFT_ONLY_PROTOCOL_VERSIONS as readonly string[]).includes(version);
}

// ─────────────────────────────────────────────────────────────────────────────
// Active-cell era. `verifies()` scopes each test body to its matrix cell so the
// harness (sniffer, HTTP hosting) knows whether the exchange is legacy-era
// without per-test plumbing. Tests within a worker run sequentially (the suite
// uses no concurrent tests), so module state is safe. Bodies registered
// outside `verifies()` default to the legacy era — the right posture for every
// raw-transport test in the suite.
// ─────────────────────────────────────────────────────────────────────────────

let activeSpecVersion: SpecVersion = '2025-11-25';

/** Run `fn` with the active matrix cell's spec version visible to the harness. */
export async function runWithCellSpecVersion<T>(version: SpecVersion, fn: () => Promise<T>): Promise<T> {
    const previous = activeSpecVersion;
    activeSpecVersion = version;
    try {
        return await fn();
    } finally {
        activeSpecVersion = previous;
    }
}

/** Whether the currently running cell is a legacy-era (pre-draft) cell. */
export function activeCellIsLegacyEra(): boolean {
    return !isDraftSpecVersion(activeSpecVersion);
}

// ─────────────────────────────────────────────────────────────────────────────
// The assertion
// ─────────────────────────────────────────────────────────────────────────────

/** Collect draft-vocabulary occurrences anywhere in a JSON value (paths included for diagnostics). */
export function findDraftVocabulary(value: unknown, path = '$'): string[] {
    if (typeof value === 'string') {
        const hit = DRAFT_ONLY_PROTOCOL_VERSIONS.find(version => value.includes(version));
        return hit ? [`draft protocol revision '${hit}' in string at ${path}`] : [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((entry, index) => findDraftVocabulary(entry, `${path}[${index}]`));
    }
    if (typeof value === 'object' && value !== null) {
        const violations: string[] = [];
        for (const [key, entry] of Object.entries(value)) {
            if (DRAFT_KEYS.has(key)) violations.push(`draft-only key '${key}' at ${path}`);
            if (key === 'code' && typeof entry === 'number' && DRAFT_ERROR_CODES.has(entry)) {
                violations.push(`draft-only error code ${entry} at ${path}.code`);
            }
            violations.push(...findDraftVocabulary(entry, `${path}.${key}`));
        }
        return violations;
    }
    return [];
}

/**
 * Leak failures are thrown at the violation site (blocking the message) AND
 * recorded here: a throw from deep inside transport plumbing (e.g. an inbound
 * `onmessage` chain) can be swallowed by error handling and surface only as a
 * test timeout, so a global `afterEach` (leak-setup.ts) re-raises any recorded
 * leak with its real diagnostic.
 */
const recordedLeaks: Error[] = [];

/** Drain the leaks recorded since the last call (see leak-setup.ts). */
export function takeRecordedLeaks(): Error[] {
    return recordedLeaks.splice(0);
}

function raiseLeak(violations: string[], context: string, payload?: unknown): void {
    const error = new Error(
        `[leak] draft-spec (2026-07-28) vocabulary must not appear on 2025-era exchanges (${context}):\n` +
            violations.map(violation => `  - ${violation}`).join('\n') +
            (payload === undefined ? '' : `\n${JSON.stringify(payload, null, 2)}`)
    );
    recordedLeaks.push(error);
    throw error;
}

/**
 * Assert a JSON-RPC message carries no draft-spec (2026-07-28) vocabulary.
 * Applied by the harness to every message of a legacy-era exchange.
 */
export function assertNoDraftVocabulary(message: unknown, context: string): void {
    const violations = findDraftVocabulary(message);
    if (violations.length > 0) raiseLeak(violations, context, message);
}

/** Assert no draft-spec (2026-07-28) header is present on a legacy-era HTTP exchange. */
export function assertNoDraftHeaders(headers: Headers, context: string): void {
    const violations: string[] = [];
    for (const [name] of headers) {
        const lower = name.toLowerCase();
        if (
            (DRAFT_ONLY_HEADER_NAMES as readonly string[]).includes(lower) ||
            DRAFT_ONLY_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix))
        ) {
            violations.push(`draft-only header '${name}'`);
        }
    }
    if (violations.length > 0) raiseLeak(violations, context);
}
