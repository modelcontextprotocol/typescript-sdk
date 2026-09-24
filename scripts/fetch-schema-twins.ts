/**
 * Vendors the generated `schema.json` twins from the spec repository into
 * `packages/core-internal/test/corpus/schema-twins/` as RAW UPSTREAM BYTES.
 *
 * The twins are TEST-ONLY conformance oracles (never bundled, never runtime):
 * `packages/core-internal/test/wire/schemaTwinConformance.test.ts` compiles them into
 * generated validators and locks the hand-written wire layer to them. Their
 * authority rests on provenance, so they are vendored verbatim — no
 * formatting of any kind (the directory is .prettierignore'd) — and each file
 * is locked to the manifest's source commit, sha256, and byte count.
 *
 * Each revision owns its source commit independently. Refreshing one released
 * revision must not move another revision's oracle.
 *
 * Usage:
 *   pnpm fetch:schema-twins
 *   pnpm fetch:schema-twins <revision>
 *   pnpm fetch:schema-twins <revision> <sha>
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

interface TwinEntry {
    sourceCommit: string;
    sha256: string;
    bytes: number;
    upstreamPath: string;
}

interface TwinManifest {
    comment: string;
    source: { repository: string };
    files: Record<string, TwinEntry>;
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
    if (manifest.source.repository !== SPEC_REPO) {
        throw new Error(`Unexpected schema-twin source repository: ${manifest.source.repository}`);
    }

    const [providedRevision, providedSHA, ...extraArgs] = process.argv.slice(2);
    if (extraArgs.length > 0) {
        throw new Error('Usage: pnpm fetch:schema-twins [revision] [sha]');
    }
    if (providedRevision !== undefined && !(providedRevision in manifest.files)) {
        throw new Error(
            `Unsupported revision "${providedRevision}". Available revisions: ${Object.keys(manifest.files).join(', ')}`
        );
    }

    for (const [revision, entry] of Object.entries(manifest.files)) {
        if (providedRevision !== undefined && revision !== providedRevision) continue;

        const sha = providedSHA ?? entry.sourceCommit;
        console.log(`[${revision}] Fetching ${entry.upstreamPath} at ${sha}`);
        const bytes = await fetchRawBytes(sha, entry.upstreamPath);

        writeFileSync(join(TWINS_DIR, `${revision}.schema.json`), bytes);
        entry.sourceCommit = sha;
        entry.sha256 = createHash('sha256').update(bytes).digest('hex');
        entry.bytes = bytes.byteLength;
        console.log(`[${revision}] ${entry.bytes} bytes, sha256 ${entry.sha256}`);
    }

    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8');
    console.log(`Updated ${MANIFEST_PATH}`);
}

main().catch((error: unknown) => {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
});
