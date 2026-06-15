/**
 * Spec example corpus — accept-side fixtures parsed through the SDK's wire schemas.
 *
 * Two corpora, one harness:
 *
 * - `fixtures/2026-07-28/` is VENDORED from the spec repository's draft
 *   example set (`schema/draft/examples/`), regenerated only via
 *   `pnpm fetch:spec-examples` (provenance in its manifest.json). Every
 *   example directory is named after a spec type; each file is a canonical
 *   instance of that type.
 * - `fixtures/2025-11-25/` is HAND-BUILT and FROZEN: upstream ships no
 *   example corpus for the released 2025-11-25 revision, so these fixtures
 *   pin representative 2025-era wire shapes (including the task wire surface
 *   that revision defines). Do not edit them casually — they are the
 *   accept-side net for any future change to how 2025-era traffic parses.
 *
 * Directory-name → schema mapping is mechanical (`<Dir>Schema`), with two
 * structural exceptions (JSON-RPC response envelopes and bare error objects)
 * and an explicit pending list for draft vocabulary the SDK does not model
 * yet. The pending list is stale-checked in both directions: a pending entry
 * whose schema appears must be removed, and an unmapped directory that is not
 * pending fails loudly — no silent skips.
 *
 * Rejection-side fixtures are deliberately NOT here: accept-only corpora are
 * blind to accept→reject deltas, so rejections are routed through real
 * dispatch in specCorpusDispatch.test.ts.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

import {
    CreateMessageResultSchema,
    CreateMessageResultWithToolsSchema,
    JSONRPCErrorResponseSchema,
    JSONRPCResultResponseSchema
} from '../../src/types/schemas.js';
import * as schemas from '../../src/types/schemas.js';
// Era routing (Q1 increment 2): each corpus revision resolves through its own
// wire-era module first — 2025 fixtures may use 2025-only vocabulary (tasks),
// 2026 fixtures use 2026-only vocabulary (envelope, discover) — then falls
// back to the shared neutral payload schemas.
import * as wire2025 from '../../src/wire/rev2025-11-25/schemas.js';
import * as wire2026 from '../../src/wire/rev2026-07-28/schemas.js';

const FIXTURES_ROOT = join(__dirname, 'fixtures');

/** JSON-RPC error-object example directories (bare `{code, message, data?}` shapes). */
const ERROR_OBJECT_DIRS = new Set([
    'InternalError',
    'InvalidParamsError',
    'MethodNotFoundError',
    'MissingRequiredClientCapabilityError',
    'ParseError',
    'UnsupportedProtocolVersionError'
]);

/**
 * Draft (2026-07-28) vocabulary the SDK does not model yet, at directory
 * granularity. Each entry names the reason; the harness asserts the schema is
 * genuinely absent so a stale entry (vocabulary landed but still listed)
 * fails loudly. These burn down as the corresponding features land.
 */
const PENDING_2026: Record<string, string> = {
    InputRequests: 'multi-round-trip request vocabulary (SEP-2322) is not modeled yet',
    InputRequiredResult: 'multi-round-trip request vocabulary (SEP-2322) is not modeled yet',
    InputResponses: 'multi-round-trip request vocabulary (SEP-2322) is not modeled yet',
    SubscriptionsAcknowledgedNotification: 'subscriptions/listen vocabulary (SEP-1865) is not modeled yet',
    SubscriptionsListenRequest: 'subscriptions/listen vocabulary (SEP-1865) is not modeled yet'
};

/**
 * Individual draft examples whose vocabulary the SDK does not accept yet
 * (file granularity — the directory's schema exists but this instance uses a
 * draft-only widening). Stale-checked: each listed file must actually FAIL to
 * parse, so the entry is removed the moment the widening lands.
 */
const PENDING_2026_FILES: Record<string, string> = {
    'CallToolResult/result-with-array-structured-content.json': 'array structuredContent (SEP-2549) is not modeled yet',
    'Tool/tool-with-array-output-schema.json': 'array outputSchema (SEP-2549) is not modeled yet'
};

type AnyZod = z.ZodType;

const ERA_SCHEMAS: Record<string, Record<string, unknown>> = {
    '2025-11-25': wire2025 as Record<string, unknown>,
    '2026-07-28': wire2026 as Record<string, unknown>
};

function schemaFor(revision: string, dir: string, fixture: unknown): AnyZod | undefined {
    if (ERROR_OBJECT_DIRS.has(dir)) {
        // The upstream error examples mix bare `{code, message, data?}` objects
        // with full JSON-RPC error responses — pick by shape.
        const isEnveloped = typeof fixture === 'object' && fixture !== null && 'jsonrpc' in fixture;
        return isEnveloped ? (JSONRPCErrorResponseSchema as AnyZod) : (JSONRPCErrorResponseSchema.shape.error as AnyZod);
    }
    if (dir.endsWith('ResultResponse')) return JSONRPCResultResponseSchema as AnyZod;
    if (dir === 'CreateMessageResult') {
        // The SDK models this spec type as two schemas (single-content and
        // tool-use array content); an example instance may be either.
        return z.union([CreateMessageResultSchema, CreateMessageResultWithToolsSchema]) as AnyZod;
    }
    const eraSchema = ERA_SCHEMAS[revision]?.[`${dir}Schema`];
    if (eraSchema !== undefined) return eraSchema as AnyZod;
    return (schemas as Record<string, unknown>)[`${dir}Schema`] as AnyZod | undefined;
}

function listTypeDirs(revision: string): string[] {
    const root = join(FIXTURES_ROOT, revision);
    return readdirSync(root)
        .filter(entry => statSync(join(root, entry)).isDirectory())
        .sort();
}

function listFixtures(revision: string, dir: string): string[] {
    return readdirSync(join(FIXTURES_ROOT, revision, dir))
        .filter(file => file.endsWith('.json'))
        .sort();
}

function loadFixture(revision: string, dir: string, file: string): unknown {
    return JSON.parse(readFileSync(join(FIXTURES_ROOT, revision, dir, file), 'utf8'));
}

describe.each(['2025-11-25', '2026-07-28'] as const)('spec example corpus %s', revision => {
    const typeDirs = listTypeDirs(revision);
    const pending = revision === '2026-07-28' ? PENDING_2026 : {};

    const pendingFiles = revision === '2026-07-28' ? PENDING_2026_FILES : {};

    test('every example directory is mapped to a schema or explicitly pending', () => {
        const unmapped = typeDirs.filter(dir => !(dir in pending) && schemaFor(revision, dir, {}) === undefined);
        expect(unmapped, 'unmapped example directories — map them or add a documented pending entry').toEqual([]);
    });

    test('pending entries are not stale (their vocabulary is still unmodeled)', () => {
        const stale = Object.keys(pending).filter(dir => schemaFor(revision, dir, {}) !== undefined);
        expect(stale, 'pending entries whose schema now exists — wire the fixtures and remove the entry').toEqual([]);
        // Pending entries must refer to directories that actually exist.
        const missing = Object.keys(pending).filter(dir => !typeDirs.includes(dir));
        expect(missing, 'pending entries without a fixture directory').toEqual([]);

        const missingFiles = Object.keys(pendingFiles).filter(relPath => {
            const [dir, file] = relPath.split('/');
            if (dir === undefined || file === undefined) return true;
            return !typeDirs.includes(dir) || !listFixtures(revision, dir).includes(file);
        });
        expect(missingFiles, 'pending file entries without a fixture file').toEqual([]);
    });

    const mappedDirs = typeDirs.filter(dir => !(dir in pending));
    describe.each(mappedDirs)('%s', dir => {
        test.each(listFixtures(revision, dir))('%s parses', file => {
            const fixture = loadFixture(revision, dir, file);
            const schema = schemaFor(revision, dir, fixture);
            expect(schema).toBeDefined();
            const parsed = schema!.safeParse(fixture);
            const pendingReason = pendingFiles[`${dir}/${file}`];
            if (pendingReason !== undefined) {
                // Stale-check: a pending file that parses means the widening
                // landed — remove the entry so the example becomes a real pin.
                expect(parsed.success, `pending entry is stale ('${dir}/${file}' now parses): ${pendingReason}`).toBe(false);
                return;
            }
            expect(parsed.success, parsed.success ? undefined : `'${dir}/${file}' failed to parse:\n${parsed.error}`).toBe(true);
        });
    });
});

describe('corpus inventory pins', () => {
    test('the vendored 2026-07-28 corpus matches its manifest (provenance + drift pin)', () => {
        const manifest = JSON.parse(readFileSync(join(FIXTURES_ROOT, '2026-07-28', 'manifest.json'), 'utf8')) as {
            revision: string;
            source: { commit: string };
            directoryCount: number;
            fileCount: number;
            directories: Record<string, string[]>;
        };
        expect(manifest.revision).toBe('2026-07-28');

        const dirs = listTypeDirs('2026-07-28');
        expect(dirs).toEqual(Object.keys(manifest.directories).sort());
        const fileCount = dirs.reduce((sum, dir) => sum + listFixtures('2026-07-28', dir).length, 0);
        expect(fileCount).toBe(manifest.fileCount);

        // The corpus size at the pinned spec commit. A change here means the
        // vendored corpus was regenerated — review the delta deliberately.
        expect(manifest.directoryCount).toBe(86);
        expect(manifest.fileCount).toBe(127);
    });

    test('the frozen 2025-11-25 corpus keeps its inventory', () => {
        const dirs = listTypeDirs('2025-11-25');
        const fileCount = dirs.reduce((sum, dir) => sum + listFixtures('2025-11-25', dir).length, 0);
        // Hand-built and frozen: growing it is welcome (raise the pin in the
        // same change); silent shrinkage is not.
        expect(fileCount).toBe(47);
    });
});
