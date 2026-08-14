/**
 * Vendors the generated `schema.json` twins from the spec repository into
 * `packages/core-internal/test/corpus/schema-twins/` as RAW UPSTREAM BYTES.
 *
 * The twins are TEST-ONLY conformance oracles (never bundled, never runtime):
 * `packages/core-internal/test/wire/schemaTwinConformance.test.ts` compiles them into
 * generated validators and locks the hand-written wire layer to them. Their
 * authority rests on provenance, so they are vendored verbatim — no
 * formatting of any kind (the directory is .prettierignore'd) — and each file
 * is locked to the manifest's sha256/byte values at test time. Any rewrite
 * (prettier, an editor, a manual touch-up) turns CI red.
 *
 * Refresh ATOMICALLY with the matching spec.types anchor (see
 * packages/core-internal/src/types/README.md lifecycle rule 4).
 *
 * Usage:
 *   pnpm fetch:schema-twins [sha]   # default: the manifest's current source commit
 *
 * Sources are fetched from GitHub at the given commit, mirroring
 * scripts/fetch-spec-types.ts; the manifest's provenance values (source
 * commit, sha256, byte size) are recomputed from the fetched bytes.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(__filename), '..');

const SPEC_REPO = 'modelcontextprotocol/modelcontextprotocol';
const TWINS_DIR = join(PROJECT_ROOT, 'packages', 'core-internal', 'test', 'corpus', 'schema-twins');
const MANIFEST_PATH = join(TWINS_DIR, 'manifest.json');

interface TwinManifest {
    comment: string;
    source: { repository: string; commit: string };
    files: Record<string, { sha256: string; bytes: number; upstreamPath: string }>;
}

async function fetchRawBytes(sha: string, upstreamPath: string): Promise<Buffer> {
    const url = `https://raw.githubusercontent.com/${SPEC_REPO}/${sha}/${upstreamPath}`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch ${upstreamPath}: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
}

async function main(): Promise<void> {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as TwinManifest;
    const sha = process.argv[2] ?? manifest.source.commit;

    for (const [revision, entry] of Object.entries(manifest.files)) {
        console.log(`[${revision}] Fetching ${entry.upstreamPath} at ${sha}`);
        const bytes = await fetchRawBytes(sha, entry.upstreamPath);
        // Verbatim: the twin IS the upstream artifact, byte for byte.
        writeFileSync(join(TWINS_DIR, `${revision}.schema.json`), bytes);
        entry.sha256 = createHash('sha256').update(bytes).digest('hex');
        entry.bytes = bytes.byteLength;
        console.log(`[${revision}] ${entry.bytes} bytes, sha256 ${entry.sha256}`);
    }

    manifest.source = { repository: SPEC_REPO, commit: sha };
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
    console.log(`Updated ${MANIFEST_PATH}`);
}

main().catch((error: unknown) => {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
