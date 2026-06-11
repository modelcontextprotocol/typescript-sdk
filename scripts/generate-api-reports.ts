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
 * Mechanics: the packages build with tsdown, which emits rolled-up `.d.mts`
 * declaration bundles per entry point. API Extractor requires a `.d.ts` entry
 * file, so for each entry we mirror the package's `dist/` declarations into a
 * scratch folder (`.api-extractor-tmp/`, gitignored), add a `.d.ts` copy of
 * the entry, and run API Extractor against that. TypeScript resolves the
 * rollups' relative `.mjs` chunk imports to the mirrored `.d.mts` files.
 *
 * Notes on coverage:
 * - `@modelcontextprotocol/core` is private and bundled into the client and
 *   server dists, so its surface is reported THROUGH those packages' reports
 *   rather than separately.
 * - The `./_shims` entries are runtime-conditional; the report covers the
 *   default (node) condition.
 * - The codemod package's `mcp-codemod` bin is a CLI, not a type surface; its
 *   contract is covered by the codemod CLI tests and the export-map topology
 *   pins. Its library entry (`.`) is reported like every other package.
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
            { dist: 'shimsNode.d.mts', report: 'client.shims' }
        ]
    },
    {
        dir: 'packages/server',
        entries: [
            { dist: 'index.d.mts', report: 'server' },
            { dist: 'stdio.d.mts', report: 'server.stdio' },
            { dist: 'validators/ajv.d.mts', report: 'server.validators-ajv' },
            { dist: 'validators/cfWorker.d.mts', report: 'server.validators-cf-worker' },
            { dist: 'shimsNode.d.mts', report: 'server.shims' }
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
    { dir: 'packages/middleware/node', entries: [{ dist: 'index.d.mts', report: 'node' }] },
    { dir: 'packages/codemod', entries: [{ dist: 'index.d.mts', report: 'codemod' }] }
];

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

function runEntry(pkg: PackageSpec, entry: EntrySpec): { changed: boolean; succeeded: boolean } {
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

    // API Extractor requires a .d.ts entry point; the mirrored chunk imports
    // (./foo.mjs) resolve to the sibling .d.mts copies.
    const entryDts = path.join(tmpDir, entry.dist.replace(/\.d\.mts$/, '.d.ts'));
    fs.copyFileSync(distEntry, entryDts);

    // The tsdown-bundled ajv declarations inline ajv's types, which reference
    // uri-js's URIComponent without importing it. The dangling reference is
    // harmless for consumers (skipLibCheck) but crashes API Extractor's symbol
    // walker, so resolve it with an ambient declaration in the scratch mirror.
    fs.writeFileSync(path.join(tmpDir, '_ambient-fixups.d.ts'), 'type URIComponent = unknown;\n');

    const packageJsonFullPath = path.join(pkgDir, 'package.json');
    const extractorConfig = ExtractorConfig.prepare({
        configObject: {
            projectFolder: tmpDir,
            mainEntryPointFilePath: entryDts,
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

    const produced = normalizeReport(fs.readFileSync(path.join(tmpDir, 'report', `${entry.report}.api.md`), 'utf8'));
    const committedPath = path.join(pkgDir, 'etc', `${entry.report}.api.md`);
    const committed = fs.existsSync(committedPath) ? fs.readFileSync(committedPath, 'utf8') : undefined;

    if (checkMode) {
        return { changed: produced !== committed, succeeded: produced === committed };
    }
    if (produced !== committed) {
        fs.writeFileSync(committedPath, produced);
        return { changed: true, succeeded: true };
    }
    return { changed: false, succeeded: true };
}

/**
 * Makes report content independent of declaration-bundle chunk layout.
 *
 * tsdown's d.mts rollups rename colliding identifiers (mostly generic type
 * parameters hoisted into a shared scope) with `$N` suffixes — e.g. `T$1` —
 * and which identifiers collide depends on how the bundle happened to be
 * chunked, which is not stable across builds. Stripping the suffix restores
 * the source-level name. Hand-written identifiers in this repo never contain
 * `$`, so the substitution cannot mask a real surface change.
 */
function normalizeReport(text: string): string {
    return text.replace(/([A-Za-z0-9_])\$\d+\b/g, '$1');
}

let failed = false;
const changedReports: string[] = [];

for (const pkg of PACKAGES) {
    for (const entry of pkg.entries) {
        const label = `${pkg.dir} → ${entry.report}.api.md`;
        try {
            const { changed, succeeded } = runEntry(pkg, entry);
            if (checkMode && !succeeded) {
                failed = true;
                changedReports.push(label);
                console.error(`CHANGED  ${label}`);
            } else {
                console.log(`${changed ? 'UPDATED ' : 'ok      '} ${label}`);
            }
        } catch (error) {
            failed = true;
            console.error(`ERROR    ${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    fs.rmSync(path.join(repoRoot, pkg.dir, '.api-extractor-tmp'), { recursive: true, force: true });
}

if (failed) {
    if (changedReports.length > 0) {
        console.error(
            '\nThe built public type surface differs from the committed API report(s) above.\n' +
                'If the change is intentional: run `pnpm api-report`, review the report diff,\n' +
                'commit it together with your change (and a changeset if consumer-facing).\n' +
                'See the header of scripts/generate-api-reports.ts.'
        );
    }
    process.exit(1);
}
