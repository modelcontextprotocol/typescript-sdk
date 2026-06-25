/**
 * Schema-twin conformance lock (Q1 increment 3 — generation as ORACLE).
 *
 * The spec repository generates `schema.json` from the same normative
 * `schema.ts` the anchors vendor. The twins vendored under
 * `corpus/schema-twins/` (TEST-ONLY — never bundled, never runtime; the
 * engines stay optional peers and the hot path stays hand-written Zod) give
 * a generated, revision-exact validator for every named spec type. This
 * suite locks the hand-written wire layer to them, per revision per fixture:
 *
 * - every accept-corpus fixture must satisfy the GENERATED validator for its
 *   directory's spec type (catches twin/anchor desync and hand-corpus drift
 *   — the 2025 mini-corpus is hand-built, so this is its only independent
 *   referee), and
 * - every fixture the SDK wire layer accepts must also be twin-valid
 *   (agreement on the accept side; reject-side deltas are owned by the
 *   dispatch-routed rejection corpus, since generated valid-only oracles are
 *   blind to them).
 *
 * Twin refresh is ATOMIC with the matching anchor (lifecycle rule 4,
 * packages/core/src/types/README.md); provenance in schema-twins/manifest.json.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { Ajv2020 as Ajv } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, test } from 'vitest';

const FIXTURES_ROOT = join(__dirname, '../corpus/fixtures');
const TWINS_ROOT = join(__dirname, '../corpus/schema-twins');

interface TwinManifest {
    source: { repository: string; commit: string };
    files: Record<string, { sha256: string; bytes: number; upstreamPath: string }>;
}

const TWIN_MANIFEST = JSON.parse(readFileSync(join(TWINS_ROOT, 'manifest.json'), 'utf8')) as TwinManifest;

describe('twin provenance integrity (the manifest lock)', () => {
    // The twins' authority as generated oracles rests on them being the raw
    // upstream artifacts, byte for byte. Hash the vendored files against the
    // manifest's provenance values at test time so ANY rewrite — prettier, an
    // editor, a manual touch-up — fails loudly. Refresh only via
    // `pnpm fetch:schema-twins` (which recomputes these values from the
    // fetched bytes), atomically with the matching spec.types anchor.
    test.each(Object.keys(TWIN_MANIFEST.files))('%s twin is byte-identical to the upstream artifact pinned in the manifest', revision => {
        const entry = TWIN_MANIFEST.files[revision]!;
        const raw = readFileSync(join(TWINS_ROOT, `${revision}.schema.json`));
        expect(raw.byteLength, `byte size drifted for ${revision} — the vendored twin was rewritten`).toBe(entry.bytes);
        expect(
            createHash('sha256').update(raw).digest('hex'),
            `sha256 drifted for ${revision} — the vendored twin was rewritten (re-vendor raw bytes via pnpm fetch:schema-twins)`
        ).toBe(entry.sha256);
    });
});

type JsonSchema = { $defs?: Record<string, { required?: string[] }> };

function twinValidatorFactory(revision: string) {
    const schema = JSON.parse(readFileSync(join(TWINS_ROOT, `${revision}.schema.json`), 'utf8')) as JsonSchema;
    const ajv = new Ajv({ strict: false, allowUnionTypes: true });
    addFormats.default ? addFormats.default(ajv) : (addFormats as unknown as (a: Ajv) => void)(ajv);
    ajv.addSchema(schema, 'spec');
    return {
        defs: new Set(Object.keys(schema.$defs ?? {})),
        requiredOf(typeName: string): string[] {
            return schema.$defs?.[typeName]?.required ?? [];
        },
        validatorFor(typeName: string) {
            return ajv.getSchema(`spec#/$defs/${typeName}`);
        }
    };
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

describe.each(['2025-11-25', '2026-07-28'] as const)('schema-twin conformance lock %s', revision => {
    const twin = twinValidatorFactory(revision);
    const dirs = listTypeDirs(revision).filter(dir => twin.defs.has(dir));

    test('the twin covers the corpus (the unmapped set is pinned exactly)', () => {
        const unmapped = listTypeDirs(revision).filter(dir => !twin.defs.has(dir));
        // Unmapped directories would be SDK-named shapes with no spec def.
        // Today there are NONE — the set is pinned exactly, not bounded with
        // slack: a new unmapped directory means the twin and the corpus are
        // drifting apart and must be adjudicated here by name.
        expect(unmapped).toEqual([]);
        expect(dirs.length).toBeGreaterThan(30);
    });

    describe.each(dirs)('%s', dir => {
        test.each(listFixtures(revision, dir))('%s satisfies the generated spec validator', file => {
            let fixture = JSON.parse(readFileSync(join(FIXTURES_ROOT, revision, dir, file), 'utf8')) as Record<string, unknown>;
            // The hand-built 2025 mini-corpus stores BARE message shapes (the
            // SDK parse surface); the spec defs model the full JSON-RPC wire
            // message. Supply the neutral envelope members the def requires
            // and the fixture deliberately omits — the PAYLOAD is what the
            // fixtures pin, and it crosses to the twin verbatim.
            const required = twin.requiredOf(dir);
            if (typeof fixture === 'object' && fixture !== null && !('jsonrpc' in fixture)) {
                if (required.includes('jsonrpc')) fixture = { jsonrpc: '2.0', ...fixture };
                if (required.includes('id') && !('id' in fixture)) fixture = { id: 'twin-probe', ...fixture };
            }
            const validate = twin.validatorFor(dir);
            expect(validate, `no compiled validator for ${dir}`).toBeDefined();
            const valid = validate!(fixture);
            expect(
                valid,
                `'${dir}/${file}' rejected by the generated ${revision} validator:\n${JSON.stringify(validate!.errors, null, 2)}`
            ).toBe(true);
        });
    });
});
