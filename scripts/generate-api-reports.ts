/**
 * Generates (or checks) the committed API reports for every public package.
 *
 * Each export-map entry of each publishable package gets an API Extractor
 * report (`packages/<pkg>/etc/<name>.api.md`) describing its complete public
 * type surface. The committed reports are the baseline: `pnpm api-report:check`
 * fails when the built surface differs from the committed report, which makes
 * every public-surface change a deliberate act (regenerate with
 * `pnpm api-report`, commit the diff, and have it reviewed).
 *
 * The PACKAGES manifest below is cross-checked against the actual package
 * export maps before anything runs: a public package or `types` target that
 * is neither listed nor explicitly exempted fails the script, so the gate
 * cannot silently lose coverage when the export maps grow.
 *
 * Mechanics: the packages build with tsdown, which emits rolled-up `.d.mts`
 * declaration bundles per entry point. Each entry's declarations are mirrored
 * into a scratch folder (`.api-extractor-tmp/`, gitignored) so the run can
 * host ambient fixups and a scoped tsconfig without polluting dist/, and API
 * Extractor runs against the mirrored `.d.mts` entry directly.
 *
 * Notes on coverage:
 * - `@modelcontextprotocol/core` is private and bundled into the client and
 *   server dists, so its surface is reported THROUGH those packages' reports
 *   rather than separately.
 * - The `./_shims` entries are runtime-conditional; every distinct `types`
 *   target gets its own report (node, workerd, and — for the client — browser).
 * - The codemod package is exempt entirely: it is migration tooling — its
 *   `mcp-codemod` bin is the contract (covered by the codemod CLI tests and
 *   the export-map topology pins), and its library surface carries no
 *   stability expectations for external consumers.
 *
 * A failing check does not mean a change is wrong — it means it is
 * surface-visible. To accept it: run `pnpm api-report`, review the report
 * diff like source, and commit it together with the change (plus a
 * changeset if consumer-facing).
 *
 * Usage:
 *   pnpm api-report          # build + regenerate the committed reports
 *   pnpm api-report:check    # build + fail on any difference (CI)
 */
import { Extractor, ExtractorConfig, ExtractorLogLevel } from '@microsoft/api-extractor';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkMode = process.argv.includes('--check');

interface EntrySpec {
    /** Entry declaration rollup, relative to the package's dist/ folder. */
    dist: string;
    /** Report file name (api-extractor appends `.api.md`). */
    report: string;
}

interface PackageSpec {
    /** Package folder relative to the repo root. */
    dir: string;
    entries: EntrySpec[];
}

const PACKAGES: PackageSpec[] = [
    {
        dir: 'packages/client',
        entries: [
            { dist: 'index.d.mts', report: 'client' },
            { dist: 'stdio.d.mts', report: 'client.stdio' },
            { dist: 'validators/ajv.d.mts', report: 'client.validators-ajv' },
            { dist: 'validators/cfWorker.d.mts', report: 'client.validators-cf-worker' },
            { dist: 'shimsNode.d.mts', report: 'client.shims' },
            { dist: 'shimsWorkerd.d.mts', report: 'client.shims-workerd' },
            { dist: 'shimsBrowser.d.mts', report: 'client.shims-browser' }
        ]
    },
    {
        dir: 'packages/server',
        entries: [
            { dist: 'index.d.mts', report: 'server' },
            { dist: 'stdio.d.mts', report: 'server.stdio' },
            { dist: 'validators/ajv.d.mts', report: 'server.validators-ajv' },
            { dist: 'validators/cfWorker.d.mts', report: 'server.validators-cf-worker' },
            { dist: 'shimsNode.d.mts', report: 'server.shims' },
            { dist: 'shimsWorkerd.d.mts', report: 'server.shims-workerd' }
        ]
    },
    {
        dir: 'packages/server-legacy',
        entries: [
            { dist: 'index.d.mts', report: 'server-legacy' },
            { dist: 'sse/index.d.mts', report: 'server-legacy.sse' },
            { dist: 'auth/index.d.mts', report: 'server-legacy.auth' }
        ]
    },
    { dir: 'packages/middleware/express', entries: [{ dist: 'index.d.mts', report: 'express' }] },
    { dir: 'packages/middleware/fastify', entries: [{ dist: 'index.d.mts', report: 'fastify' }] },
    { dir: 'packages/middleware/hono', entries: [{ dist: 'index.d.mts', report: 'hono' }] },
    { dir: 'packages/middleware/node', entries: [{ dist: 'index.d.mts', report: 'node' }] }
];

/** Public packages deliberately excluded from API reports, with the reason on record. */
const EXEMPT_PACKAGES = new Map<string, string>([
    ['packages/codemod', 'migration tooling: the mcp-codemod bin is the contract (codemod CLI tests + export-map topology pins)']
]);

/** Collect every `types` target reachable through an export-map value (handles nested conditions). */
function collectTypesTargets(node: unknown, out: Set<string>): void {
    if (typeof node !== 'object' || node === null) {
        return;
    }
    for (const [key, value] of Object.entries(node)) {
        if (key === 'types' && typeof value === 'string') {
            out.add(value);
        } else {
            collectTypesTargets(value, out);
        }
    }
}

/** Find every package manifest under packages/ (top-most manifest wins; scratch/build dirs skipped). */
function discoverPackageDirs(dir: string, found: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
            continue;
        }
        const sub = path.join(dir, entry.name);
        if (fs.existsSync(path.join(sub, 'package.json'))) {
            found.push(sub);
        } else {
            discoverPackageDirs(sub, found);
        }
    }
    return found;
}

/**
 * Fails when PACKAGES drifts from reality: a public package missing from the
 * manifest (and not exempted), an export-map `types` target with no report
 * entry, a report entry no export targets, or a private/exempt package still
 * carrying committed reports.
 */
function verifyManifestCoverage(): void {
    const problems: string[] = [];
    const byDir = new Map(PACKAGES.map(pkg => [pkg.dir, pkg]));

    for (const abs of discoverPackageDirs(path.join(repoRoot, 'packages'))) {
        const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
        const manifest = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8')) as {
            private?: boolean;
            exports?: Record<string, unknown>;
        };
        const pkg = byDir.get(rel);

        if (manifest.private === true || EXEMPT_PACKAGES.has(rel)) {
            if (pkg) {
                problems.push(`${rel} is ${manifest.private ? 'private' : 'exempt'} but listed in PACKAGES`);
            }
            const etcDir = path.join(abs, 'etc');
            if (fs.existsSync(etcDir)) {
                for (const file of fs.readdirSync(etcDir)) {
                    if (file.endsWith('.api.md')) {
                        problems.push(`${rel}/etc/${file} exists but the package is not reported — remove it`);
                    }
                }
            }
            continue;
        }
        if (!pkg) {
            problems.push(
                `${rel} is a public package with no PACKAGES entry — add its export entries (or an explicit exemption with a reason)`
            );
            continue;
        }

        const targets = new Set<string>();
        collectTypesTargets(manifest.exports ?? {}, targets);
        const targetDists = new Set([...targets].map(target => target.replace(/^\.\/dist\//, '')));
        const listedDists = new Set(pkg.entries.map(entry => entry.dist));
        for (const dist of targetDists) {
            if (!listedDists.has(dist)) {
                problems.push(`${rel}: exports types target ./dist/${dist} has no report entry in PACKAGES`);
            }
        }
        for (const dist of listedDists) {
            if (!targetDists.has(dist)) {
                problems.push(`${rel}: report entry ${dist} matches no exports types target`);
            }
        }
    }

    for (const pkg of PACKAGES) {
        if (!fs.existsSync(path.join(repoRoot, pkg.dir, 'package.json'))) {
            problems.push(`${pkg.dir} is listed in PACKAGES but has no package.json`);
        }
    }

    if (problems.length > 0) {
        throw new Error(`PACKAGES is out of sync with the package export maps:\n  ${problems.join('\n  ')}`);
    }
}

/** Recursively copy every .d.mts file under distDir into mirrorDir. */
function mirrorDeclarations(distDir: string, mirrorDir: string): number {
    let copied = 0;
    for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
        const from = path.join(distDir, entry.name);
        if (entry.isDirectory()) {
            copied += mirrorDeclarations(from, path.join(mirrorDir, entry.name));
        } else if (entry.name.endsWith('.d.mts')) {
            fs.mkdirSync(mirrorDir, { recursive: true });
            fs.copyFileSync(from, path.join(mirrorDir, entry.name));
            copied += 1;
        }
    }
    return copied;
}

type EntryStatus = 'ok' | 'updated' | 'changed' | 'missing';

function runEntry(pkg: PackageSpec, entry: EntrySpec): EntryStatus {
    const pkgDir = path.join(repoRoot, pkg.dir);
    const distDir = path.join(pkgDir, 'dist');
    const distEntry = path.join(distDir, entry.dist);
    if (!fs.existsSync(distEntry)) {
        throw new Error(`Missing build output ${distEntry} — run the package builds first (pnpm api-report does this).`);
    }

    const tmpDir = path.join(pkgDir, '.api-extractor-tmp', entry.report);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    mirrorDeclarations(distDir, tmpDir);
    fs.mkdirSync(path.join(pkgDir, 'etc'), { recursive: true });

    // The tsdown-bundled ajv declarations inline ajv's types, which reference
    // uri-js's URIComponent without importing it. The dangling reference is
    // harmless for consumers (skipLibCheck) but crashes API Extractor's symbol
    // walker, so resolve it with an ambient declaration in the scratch mirror.
    // (Injected for every entry: it is ambient-only and never exported, so it
    // cannot appear in a report.)
    fs.writeFileSync(path.join(tmpDir, '_ambient-fixups.d.ts'), 'type URIComponent = unknown;\n');

    const packageJsonFullPath = path.join(pkgDir, 'package.json');
    const extractorConfig = ExtractorConfig.prepare({
        configObject: {
            projectFolder: tmpDir,
            // API Extractor consumes the mirrored .d.mts entry directly
            // (supported since 7.36.2); the rollups' relative .mjs chunk
            // imports resolve to the sibling mirrored .d.mts files.
            mainEntryPointFilePath: path.join(tmpDir, entry.dist),
            newlineKind: 'lf',
            compiler: {
                overrideTsconfig: {
                    compilerOptions: {
                        module: 'esnext',
                        moduleResolution: 'bundler',
                        target: 'es2022',
                        lib: ['es2023', 'dom'],
                        types: ['node'],
                        skipLibCheck: true
                    },
                    include: ['**/*.d.ts', '**/*.d.mts']
                }
            },
            apiReport: {
                enabled: true,
                reportFileName: entry.report,
                // The report is produced into the scratch folder and compared /
                // committed by this script (after normalization), never written
                // to etc/ by API Extractor directly.
                reportFolder: path.join(tmpDir, 'report'),
                reportTempFolder: path.join(tmpDir, 'report'),
                includeForgottenExports: true
            },
            docModel: { enabled: false },
            dtsRollup: { enabled: false },
            tsdocMetadata: { enabled: false },
            messages: {
                extractorMessageReporting: {
                    'ae-missing-release-tag': { logLevel: ExtractorLogLevel.None },
                    // Not added to the report file: the warning text embeds
                    // declaration-bundle chunk file names and line numbers,
                    // which vary with tsdown's chunking and would make the
                    // committed reports nondeterministic. The forgotten symbols
                    // themselves still appear in the report body.
                    'ae-forgotten-export': { logLevel: ExtractorLogLevel.None, addToApiReportFile: false },
                    'ae-unresolved-link': { logLevel: ExtractorLogLevel.None }
                },
                tsdocMessageReporting: {
                    default: { logLevel: ExtractorLogLevel.None }
                }
            }
        },
        configObjectFullPath: path.join(tmpDir, 'api-extractor.json'),
        packageJsonFullPath
    });

    const result = Extractor.invoke(extractorConfig, {
        localBuild: true,
        showVerboseMessages: false
    });
    if (!result.succeeded) {
        throw new Error('API Extractor reported errors');
    }

    const raw = fs.readFileSync(path.join(tmpDir, 'report', `${entry.report}.api.md`), 'utf8');
    const produced = normalizeReport(raw, `${pkg.dir} → ${entry.report}.api.md`);
    const committedPath = path.join(pkgDir, 'etc', `${entry.report}.api.md`);
    const committed = fs.existsSync(committedPath) ? fs.readFileSync(committedPath, 'utf8') : undefined;

    if (checkMode) {
        if (committed === undefined) {
            return 'missing';
        }
        return produced === committed ? 'ok' : 'changed';
    }
    if (produced !== committed) {
        fs.writeFileSync(committedPath, produced);
        return 'updated';
    }
    return 'ok';
}

/*
 * Report normalization
 * --------------------
 * tsdown's d.mts rollups rename identifiers that collide when hoisted into the
 * bundle's shared scope with `$N` suffixes (e.g. `Ajv$1`), and both whether a
 * collision happens and which declaration keeps the bare name depend on how
 * the bundle was chunked — which shifts whenever the module graph changes.
 * Committing raw reports would therefore churn on surface-neutral changes.
 *
 * Blanket-stripping the suffixes is not sound either: distinct types sharing a
 * source name would fold into one (masking reference-identity changes), and a
 * text-global regex would also rewrite string-literal types that happen to
 * contain `$<digits>`.
 *
 * So normalization works structurally on the report's declaration blocks:
 * 1. Group declarations whose names differ only by a `$N` suffix.
 * 2. Compute each group member's layout-independent identity: its blocks with
 *    every `$N` suffix erased, string-literal content untouched.
 * 3. Members with identical identities are the same type duplicated across
 *    chunks: they all take the bare name and fold into one block.
 * 4. Members with distinct identities are genuinely different types sharing a
 *    source name: they get deterministic, identity-ranked names (`Foo`,
 *    `Foo$2`, …) so they stay distinguishable regardless of chunk layout.
 * 5. Renames apply in a single token pass that skips string and template
 *    literal content, blocks are deduped and re-sorted by name, and any
 *    rollup suffix that survives normalization fails the run loudly.
 */

/**
 * Apply `replace` to every match of `re` (global) in the code portions of
 * `text`, leaving the content of '…'/"…" strings and `…` template literals
 * untouched (template interpolations `${…}` are treated as code) and copying
 * `// …` comment lines verbatim.
 */
function replaceOutsideStrings(text: string, re: RegExp, replace: (match: string) => string): string {
    let out = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        const ch = text[i];
        if (ch === "'" || ch === '"') {
            let j = i + 1;
            while (j < n && text[j] !== ch) {
                j += text[j] === '\\' ? 2 : 1;
            }
            out += text.slice(i, Math.min(j + 1, n));
            i = j + 1;
        } else if (ch === '`') {
            out += '`';
            let j = i + 1;
            while (j < n && text[j] !== '`') {
                if (text[j] === '\\') {
                    out += text.slice(j, j + 2);
                    j += 2;
                } else if (text[j] === '$' && text[j + 1] === '{') {
                    let depth = 1;
                    let k = j + 2;
                    while (k < n && depth > 0) {
                        if (text[k] === '{') depth += 1;
                        else if (text[k] === '}') depth -= 1;
                        k += 1;
                    }
                    out += '${' + replaceOutsideStrings(text.slice(j + 2, k - 1), re, replace) + '}';
                    j = k;
                } else {
                    out += text[j];
                    j += 1;
                }
            }
            if (j < n) {
                out += '`';
            }
            i = j + 1;
        } else if (ch === '/' && text[i + 1] === '/') {
            const lineEnd = text.indexOf('\n', i);
            const end = lineEnd === -1 ? n : lineEnd;
            out += text.slice(i, end);
            i = end;
        } else {
            let j = i;
            while (j < n && text[j] !== "'" && text[j] !== '"' && text[j] !== '`' && !(text[j] === '/' && text[j + 1] === '/')) {
                j += 1;
            }
            out += text.slice(i, j).replace(re, replace);
            i = j;
        }
    }
    return out;
}

/** Split fence content into blocks: blank lines at bracket depth zero are boundaries. */
function splitBlocks(content: string): string[] {
    const blocks: string[] = [];
    let current: string[] = [];
    let depth = 0;
    for (const line of content.split('\n')) {
        if (line.trim() === '' && depth === 0) {
            if (current.length > 0) {
                blocks.push(current.join('\n'));
                current = [];
            }
            continue;
        }
        current.push(line);
        depth = Math.max(0, depth + bracketDelta(line));
    }
    if (current.length > 0) {
        blocks.push(current.join('\n'));
    }
    return blocks;
}

function bracketDelta(line: string): number {
    let delta = 0;
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote !== null) {
            if (ch === '\\') {
                i += 1;
            } else if (ch === quote) {
                quote = null;
            }
        } else if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
        } else if (ch === '/' && line[i + 1] === '/') {
            break;
        } else if (ch === '{' || ch === '(' || ch === '[') {
            delta += 1;
        } else if (ch === '}' || ch === ')' || ch === ']') {
            delta -= 1;
        }
    }
    return delta;
}

const DECLARATION_RE =
    /^(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|enum|namespace|function|type|const|let|var)\s+([A-Za-z_$][\w$]*)/;

/** The name a declaration block declares, or null for imports/footers/unrecognized blocks. */
function declaredName(block: string): string | null {
    for (const line of block.split('\n')) {
        if (line.startsWith('//')) {
            continue;
        }
        const match = line.match(DECLARATION_RE);
        return match ? match[1] : null;
    }
    return null;
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const SUFFIX_TOKEN_RE = /\b[A-Za-z_][A-Za-z0-9_]*(?:\$\d+)+\b/g;

/** Erase every rollup `$N` suffix outside string literals (identity computation only). */
function eraseAllSuffixes(text: string): string {
    return replaceOutsideStrings(text, SUFFIX_TOKEN_RE, token => token.replace(/(?:\$\d+)+$/, ''));
}

/**
 * Rename rollup-suffixed tokens that are local to one block — generic type
 * parameters renamed because they collide with a hoisted top-level name (e.g.
 * `StrictNullChecksWrapper<Name$1 extends string, …>` next to a top-level
 * `Name` class). Such names are alpha-renamable within their block: each gets
 * the bare base name unless that would capture an existing token in the block,
 * in which case it gets the first free `base$K` by first-appearance order —
 * deterministic regardless of which `$N` the bundler happened to pick.
 */
function renameLocalSuffixes(block: string, knownAliases: Set<string>): string {
    const order: string[] = [];
    const found = new Set<string>();
    replaceOutsideStrings(block, SUFFIX_TOKEN_RE, token => {
        if (!knownAliases.has(token) && !found.has(token)) {
            found.add(token);
            order.push(token);
        }
        return token;
    });
    if (order.length === 0) {
        return block;
    }
    const placeholderOf = new Map(order.map((token, i) => [token, `\u0000${i}\u0000`]));
    let text = replaceOutsideStrings(block, SUFFIX_TOKEN_RE, token => placeholderOf.get(token) ?? token);
    const present = new Set(text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
    for (const raw of order) {
        const base = raw.match(/^(.*[A-Za-z0-9_])(?:\$\d+)+$/)![1];
        let alias = base;
        for (let k = 2; present.has(alias); k++) {
            alias = `${base}$${k}`;
        }
        present.add(alias);
        knownAliases.add(alias);
        text = text.split(placeholderOf.get(raw)!).join(alias);
    }
    return text;
}

function normalizeReport(text: string, label: string): string {
    const lf = text.replace(/\r\n/g, '\n');
    const fenceOpen = lf.indexOf('```ts\n');
    const fenceClose = lf.lastIndexOf('\n```');
    if (fenceOpen === -1 || fenceClose === -1 || fenceClose <= fenceOpen) {
        throw new Error(`${label}: unexpected report layout (no \`\`\`ts fence)`);
    }
    const prolog = lf.slice(0, fenceOpen + '```ts\n'.length);
    const epilog = lf.slice(fenceClose);
    const body = lf.slice(fenceOpen + '```ts\n'.length, fenceClose);

    // 1. Index declarations by name (a name can own several blocks: overloads).
    const blocksByName = new Map<string, string[]>();
    for (const block of splitBlocks(body)) {
        const name = declaredName(block);
        if (name !== null) {
            const list = blocksByName.get(name) ?? [];
            list.push(block);
            blocksByName.set(name, list);
        }
    }

    // 2. Group `$N`-suffixed declarations with their base name and assign
    //    aliases by layout-independent identity.
    const groups = new Map<string, string[]>();
    for (const name of blocksByName.keys()) {
        const base = name.match(/^(.*[A-Za-z0-9_])(?:\$\d+)+$/)?.[1];
        if (base !== undefined) {
            const members = groups.get(base) ?? [];
            members.push(name);
            groups.set(base, members);
        }
    }
    const rename = new Map<string, string>();
    const assignedAliases = new Set<string>();
    for (const [base, suffixed] of groups) {
        const members = blocksByName.has(base) ? [base, ...suffixed] : suffixed;
        const identities = new Map(members.map(raw => [raw, blocksByName.get(raw)!.map(eraseAllSuffixes).sort().join('\n\n')]));
        // Exported declarations outrank internal ones so the public type keeps
        // the bare name (`export class Ajv extends Ajv$2`, not the reverse).
        const rankKey = (identity: string) => `${/^export\s/m.test(identity) ? 0 : 1} ${identity}`;
        const distinct = [...new Set(identities.values())].sort((a, b) => (rankKey(a) < rankKey(b) ? -1 : 1));
        for (const raw of members) {
            const rank = distinct.indexOf(identities.get(raw)!);
            const alias = rank === 0 ? base : `${base}$${rank + 1}`;
            rename.set(raw, alias);
            assignedAliases.add(alias);
        }
    }

    // 3. Apply all renames in one token pass (longest-first alternation, so a
    //    swap like Foo↔Foo$2 cannot cascade), skipping string literals.
    let renamed = body;
    if (rename.size > 0) {
        const alternation = [...rename.keys()]
            .sort((a, b) => b.length - a.length)
            .map(escapeRegExp)
            .join('|');
        const tokenRe = new RegExp(`\\b(?:${alternation})\\b`, 'g');
        renamed = replaceOutsideStrings(body, tokenRe, raw => rename.get(raw) ?? raw);
    }

    // 4. Re-assemble: imports first (original order), declarations deduped and
    //    sorted by (name, body), footer comments last.
    const imports: string[] = [];
    const footers: string[] = [];
    const decls: { name: string; text: string }[] = [];
    const seen = new Set<string>();
    for (const rawBlock of splitBlocks(renamed)) {
        const block = renameLocalSuffixes(rawBlock, assignedAliases);
        if (/^import[\s{]/.test(block)) {
            if (!seen.has(block)) {
                seen.add(block);
                imports.push(block);
            }
        } else if (block.startsWith('// (No @packageDocumentation')) {
            footers.push(block);
        } else if (!seen.has(block)) {
            // Duplicate blocks are the same type emitted into several chunks;
            // after renaming they are byte-identical and fold into one.
            seen.add(block);
            decls.push({ name: declaredName(block) ?? '', text: block });
        }
    }
    decls.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

    const normalizedBody = [...imports, ...decls.map(d => d.text), ...footers].join('\n\n');

    // 5. Any surviving rollup suffix that is not one of our deterministic
    //    aliases means normalization missed a case — fail rather than commit
    //    a layout-dependent baseline. The scan covers the code body only: the
    //    markdown prolog/epilog contain the ```ts fence, whose backticks would
    //    desynchronize the scanner's template-literal tracking.
    const leftovers = new Set<string>();
    replaceOutsideStrings(normalizedBody, SUFFIX_TOKEN_RE, token => {
        leftovers.add(token);
        return token;
    });
    for (const token of leftovers) {
        if (!assignedAliases.has(token)) {
            throw new Error(`${label}: leftover rollup suffix '${token}' — normalization missed a collision case`);
        }
    }

    return prolog + '\n' + normalizedBody + epilog;
}

verifyManifestCoverage();

let failed = false;
let mismatches = 0;

for (const pkg of PACKAGES) {
    const expectedReports = new Set(pkg.entries.map(entry => `${entry.report}.api.md`));
    for (const entry of pkg.entries) {
        const label = `${pkg.dir} → ${entry.report}.api.md`;
        try {
            const status = runEntry(pkg, entry);
            if (status === 'changed' || status === 'missing') {
                failed = true;
                mismatches += 1;
                console.error(`${status === 'missing' ? 'MISSING ' : 'CHANGED '} ${label}`);
            } else {
                console.log(`${status === 'updated' ? 'UPDATED ' : 'ok      '} ${label}`);
            }
        } catch (error) {
            failed = true;
            console.error(`ERROR    ${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Committed reports nothing produces anymore are stale baselines: fail the
    // check on them, and clean them up on regeneration.
    const etcDir = path.join(repoRoot, pkg.dir, 'etc');
    if (fs.existsSync(etcDir)) {
        for (const file of fs.readdirSync(etcDir)) {
            if (!file.endsWith('.api.md') || expectedReports.has(file)) {
                continue;
            }
            if (checkMode) {
                failed = true;
                console.error(`ORPHAN   ${pkg.dir}/etc/${file} — no PACKAGES entry produces it; remove it (pnpm api-report does)`);
            } else {
                fs.rmSync(path.join(etcDir, file));
                console.log(`REMOVED  ${pkg.dir}/etc/${file} (orphan)`);
            }
        }
    }
    fs.rmSync(path.join(repoRoot, pkg.dir, '.api-extractor-tmp'), { recursive: true, force: true });
}

if (failed) {
    if (mismatches > 0) {
        console.error(
            '\nThe built public type surface differs from the committed API report(s) above.\n' +
                'If the change is intentional: run `pnpm api-report`, review the report diff,\n' +
                'commit it together with your change (and a changeset if consumer-facing).\n' +
                'See the header of scripts/generate-api-reports.ts.'
        );
    }
    process.exit(1);
}
