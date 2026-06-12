/**
 * Vendors the draft-revision (2026-07-28) example corpus from the spec
 * repository into `packages/core/test/corpus/fixtures/2026-07-28/`.
 *
 * The spec repository ships canonical example instances for the draft schema
 * (`schema/draft/examples/<TypeName>/*.json`). The corpus harness
 * (`packages/core/test/corpus/specCorpus.test.ts`) parses every vendored
 * example through the SDK's wire schemas, so accept-side drift between the
 * SDK and the specification turns CI red.
 *
 * Files are vendored verbatim, plus a `manifest.json` recording provenance
 * (source commit) and the directory/file inventory so corpus drift is loud.
 *
 * Usage:
 *   pnpm fetch:spec-examples --spec-dir <path-to-spec-checkout>
 *   pnpm fetch:spec-examples [sha]     # fetch from GitHub (default: latest main)
 *
 * With `--spec-dir`, examples are read from a local checkout of
 * modelcontextprotocol/modelcontextprotocol (provenance is the checkout's
 * HEAD commit). Without it, sources are fetched from GitHub at the given
 * commit, mirroring scripts/fetch-spec-types.ts.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(dirname(__filename), '..');

const SPEC_REPO = 'modelcontextprotocol/modelcontextprotocol';
/** The upcoming protocol revision; its examples live in the spec repo's draft directory. */
const DRAFT_REVISION = '2026-07-28';
const EXAMPLES_PATH = 'schema/draft/examples';
const OUTPUT_DIR = join(PROJECT_ROOT, 'packages', 'core', 'test', 'corpus', 'fixtures', DRAFT_REVISION);

interface ExampleFile {
    /** `<TypeName>/<file>.json` relative to the examples root. */
    relPath: string;
    content: string;
}

async function fetchLatestSHA(): Promise<string> {
    const url = `https://api.github.com/repos/${SPEC_REPO}/commits?path=${EXAMPLES_PATH}&per_page=1`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch commit info: ${response.status} ${response.statusText}`);
    const commits = (await response.json()) as Array<{ sha: string }>;
    if (!commits?.length) throw new Error('No commits found for the examples path');
    return commits[0].sha;
}

async function listExamplesFromGitHub(sha: string): Promise<string[]> {
    const url = `https://api.github.com/repos/${SPEC_REPO}/git/trees/${sha}?recursive=1`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch repo tree: ${response.status} ${response.statusText}`);
    const tree = (await response.json()) as { truncated?: boolean; tree: Array<{ path: string; type: string }> };
    if (tree.truncated) throw new Error('GitHub tree listing truncated; cannot enumerate examples reliably');
    return tree.tree
        .filter(entry => entry.type === 'blob' && entry.path.startsWith(`${EXAMPLES_PATH}/`) && entry.path.endsWith('.json'))
        .map(entry => entry.path.slice(EXAMPLES_PATH.length + 1));
}

async function fetchExamplesFromGitHub(sha: string): Promise<ExampleFile[]> {
    const relPaths = await listExamplesFromGitHub(sha);
    const files: ExampleFile[] = [];
    for (const relPath of relPaths) {
        const url = `https://raw.githubusercontent.com/${SPEC_REPO}/${sha}/${EXAMPLES_PATH}/${relPath}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch ${relPath}: ${response.status} ${response.statusText}`);
        files.push({ relPath, content: await response.text() });
    }
    return files;
}

function readExamplesFromDir(specDir: string): { files: ExampleFile[]; sha: string } {
    const root = join(specDir, ...EXAMPLES_PATH.split('/'));
    const files: ExampleFile[] = [];
    for (const typeDir of readdirSync(root).sort()) {
        const dirPath = join(root, typeDir);
        if (!statSync(dirPath).isDirectory()) continue;
        for (const file of readdirSync(dirPath).sort()) {
            if (!file.endsWith('.json')) continue;
            files.push({ relPath: `${typeDir}/${file}`, content: readFileSync(join(dirPath, file), 'utf8') });
        }
    }
    const sha = execFileSync('git', ['-C', specDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return { files, sha };
}

function writeCorpus(files: ExampleFile[], sha: string): void {
    if (files.length === 0) throw new Error('No example files found — refusing to write an empty corpus');

    rmSync(OUTPUT_DIR, { recursive: true, force: true });
    mkdirSync(OUTPUT_DIR, { recursive: true });

    const dirs: Record<string, string[]> = {};
    for (const file of files.sort((a, b) => a.relPath.localeCompare(b.relPath))) {
        // The path components come from outside this repo (a spec checkout or the
        // GitHub trees API); reject anything that could escape the output directory.
        const parts = file.relPath.split('/');
        if (parts.length !== 2 || parts.some(p => !p || p === '.' || p === '..' || p.includes('\\'))) {
            throw new Error(`Unsafe or unexpected example path: ${file.relPath}`);
        }
        const [typeDir, fileName] = parts as [string, string];
        const destFile = resolve(OUTPUT_DIR, typeDir, fileName);
        if (!destFile.startsWith(resolve(OUTPUT_DIR) + sep)) {
            throw new Error(`Example path escapes the output directory: ${file.relPath}`);
        }
        mkdirSync(join(OUTPUT_DIR, typeDir), { recursive: true });
        // Validate now so a malformed upstream example fails the vendoring, not the harness.
        JSON.parse(file.content);
        writeFileSync(destFile, file.content);
        (dirs[typeDir] ??= []).push(fileName);
    }

    const manifest = {
        revision: DRAFT_REVISION,
        source: { repo: SPEC_REPO, path: EXAMPLES_PATH, commit: sha },
        regenerate: 'pnpm fetch:spec-examples --spec-dir <spec-checkout>   # or [sha] to fetch from GitHub',
        directoryCount: Object.keys(dirs).length,
        fileCount: files.length,
        directories: dirs
    };
    writeFileSync(join(OUTPUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 4)}\n`);

    console.log(`Vendored ${files.length} example files across ${Object.keys(dirs).length} directories (source ${sha.slice(0, 8)})`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const specDirIndex = args.indexOf('--spec-dir');

    if (specDirIndex !== -1) {
        const specDir = args[specDirIndex + 1];
        if (!specDir) throw new Error('--spec-dir requires a path argument');
        const { files, sha } = readExamplesFromDir(specDir);
        writeCorpus(files, sha);
        return;
    }

    const sha = args[0] ?? (await fetchLatestSHA());
    const files = await fetchExamplesFromGitHub(sha);
    writeCorpus(files, sha);
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});
