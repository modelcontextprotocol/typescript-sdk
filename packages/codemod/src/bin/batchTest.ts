#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { V2_PACKAGE_VERSIONS } from '../versions';
import { getMigration } from '../migrations/index';
import { run } from '../runner';
import type { Diagnostic, Migration } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PackageEntry {
    dir: string;
    sourceDir?: string;
    checks?: Record<string, string | null>;
}

interface RepoEntry {
    repo: string;
    ref?: string;
    packages?: PackageEntry[];
}

interface CheckResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

interface PackageReport {
    dir: string;
    sourceDir: string;
    codemod: {
        filesChanged: number;
        totalChanges: number;
        diagnostics: Diagnostic[];
        cli?: { exitCode: number; stdout: string; stderr: string };
    };
    baseline: Record<string, CheckResult>;
    postCodemod: Record<string, CheckResult>;
}

interface RepoReport {
    repo: string;
    ref: string;
    timestamp: string;
    packageManager: string;
    packages: PackageReport[];
}

interface SummaryEntry {
    repo: string;
    package: string;
    baselineClean: boolean;
    postCodemodClean: boolean;
    newErrors: Record<string, number>;
    codemodDiagnostics: Record<string, number>;
}

interface SummaryConfig {
    codemodSource: Source;
    sdkSource: Source;
    codemodVersionSpec: string;
    codemodVersionResolved: string | null;
    sdkVersionSpec: string | null;
    sdkVersionResolved: string | null;
    resultsDir: string;
}

interface Summary {
    timestamp: string;
    codemodVersion: string;
    codemodCommit: string;
    config: SummaryConfig;
    sdkVersions: Record<string, string>; // per-package installed versions, best-effort across the run (workspace versions when sdk=local)
    totalRepos: number;
    totalPackages: number;
    results: SummaryEntry[];
    aggregated: {
        reposClean: number;
        reposWithNewErrors: number;
        totalNewTypecheckErrors: number;
        totalCodemodWarnings: number;
    };
}

type Source = 'local' | 'published';

interface BatchTestOptions {
    manifest: string;
    sdk: Source;
    codemod: Source;
    codemodVersion: string;
    sdkVersion?: string;
}

export interface ResolvedConfig {
    codemodSource: Source;
    sdkSource: Source;
    codemodVersionSpec: string; // requested (e.g. 'latest')
    codemodVersionResolved: string | null; // concrete; null when codemod=local
    sdkVersionSpec: string | null; // --sdk-version or null
    sdkVersionResolved: string | null; // representative (server) concrete; null when sdk=local OR sdk-from-codemod
    resultsDir: string; // e.g. 'results/codemod-local__sdk-local'
}

interface CodemodOutcome {
    filesChanged: number;
    totalChanges: number;
    diagnostics: Diagnostic[]; // [] in published mode
    cli?: { exitCode: number; stdout: string; stderr: string }; // published mode only
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SDK_ROOT = path.resolve(SCRIPT_DIR, '../../../..');
const BATCH_DIR = path.resolve(SDK_ROOT, 'packages/codemod/batch-test');

const LOCAL_PACKAGE_DIRS: Record<string, string> = {
    '@modelcontextprotocol/client': path.join(SDK_ROOT, 'packages/client'),
    '@modelcontextprotocol/core-internal': path.join(SDK_ROOT, 'packages/core-internal'),
    '@modelcontextprotocol/server': path.join(SDK_ROOT, 'packages/server'),
    '@modelcontextprotocol/server-legacy': path.join(SDK_ROOT, 'packages/server-legacy'),
    '@modelcontextprotocol/core': path.join(SDK_ROOT, 'packages/core'),
    '@modelcontextprotocol/express': path.join(SDK_ROOT, 'packages/middleware/express'),
    '@modelcontextprotocol/fastify': path.join(SDK_ROOT, 'packages/middleware/fastify'),
    '@modelcontextprotocol/hono': path.join(SDK_ROOT, 'packages/middleware/hono'),
    '@modelcontextprotocol/node': path.join(SDK_ROOT, 'packages/middleware/node')
};

// v2 packages a target repo can depend on = every locally-mapped package except the private,
// never-published core-internal (mirrors PRIVATE_PACKAGES in utils/packageJsonUpdater.ts).
const PUBLISHABLE_V2_PACKAGES: string[] = Object.keys(LOCAL_PACKAGE_DIRS).filter(name => name !== '@modelcontextprotocol/core-internal');

const TARBALL_DIR = path.join(BATCH_DIR, 'tarballs');

const CHECK_SCRIPT_NAMES: Record<string, string[]> = {
    typecheck: ['typecheck', 'type-check', 'check:types', 'tsc'],
    build: ['build', 'compile'],
    test: ['test', 'test:unit', 'test:all'],
    lint: ['lint', 'lint:check']
};

function detectPm(repoRoot: string): string {
    if (existsSync(path.join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(path.join(repoRoot, 'yarn.lock'))) return 'yarn';
    if (existsSync(path.join(repoRoot, 'bun.lockb'))) return 'bun';
    return 'npm';
}

export function installCommand(pm: string, opts: { hasOwnPnpmWorkspace: boolean; packageDirs: string[] }): string {
    if (pm !== 'pnpm') return `${pm} install --ignore-scripts`;
    // --no-frozen-lockfile: the codemod rewrites package.json to swap v1 → v2 deps, so the lockfile must
    //   be allowed to change. CI=true (set in shell()) otherwise defaults pnpm to a frozen lockfile and the
    //   post-codemod reinstall silently skips the new v2 deps, leaving the clone on v1.
    if (opts.hasOwnPnpmWorkspace) {
        // The clone is its OWN pnpm workspace — pnpm-workspace.yaml defines catalog:/workspace: deps
        // (e.g. mastra). `--ignore-workspace` would discard that file and pnpm would fail to resolve them
        // (ERR_PNPM_CATALOG_ENTRY_NOT_FOUND_FOR_SPEC; unresolved workspace: links → repo skipped). We don't
        // need it: the SDK workspace excludes the clones (`!packages/codemod/batch-test/**`) and pnpm uses
        // the clone's own pnpm-workspace.yaml as the nearest root. Scope the install to the target packages
        // and their dependencies (`{./<dir>}...`) so a monorepo target installs only what the checks need
        // (e.g. 2 of mastra's 161 projects) instead of the whole tree. The braces are load-bearing: pnpm
        // silently ignores the trailing `...` on a bare `./<dir>...` path selector (installing the package
        // without its workspace deps); the `{./<dir>}...` form honors it.
        const filters = opts.packageDirs
            .filter(dir => dir !== '.')
            .map(dir => `--filter ${JSON.stringify(`{./${dir}}...`)}`)
            .join(' ');
        return `pnpm install --ignore-scripts --no-frozen-lockfile${filters ? ` ${filters}` : ''}`;
    }
    // Single-package clone with no workspace of its own: pnpm would walk up to the (clone-excluding) SDK
    // workspace and never populate the clone's node_modules. `--ignore-workspace` treats it as standalone.
    // npm/yarn/bun key off a `workspaces` field in package.json (absent at this repo root).
    return 'pnpm install --ignore-scripts --ignore-workspace --no-frozen-lockfile';
}

function detectCheckCmd(pkgDir: string, checkType: string): string | null {
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) return null;

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { scripts?: Record<string, string> };
    const scripts = pkgJson.scripts ?? {};
    const candidates = CHECK_SCRIPT_NAMES[checkType] ?? [];

    for (const name of candidates) {
        if (name in scripts) return name;
    }

    if (checkType === 'typecheck') return '__fallback_tsc';
    return null;
}

// The batch test is invoked via pnpm, which exports its own config (minimum-release-age,
// frozen-lockfile, catalogs, …) as npm_config_*/PNPM_* env vars. Those leak into every subprocess and
// break things — recent-version installs get blocked by minimum-release-age, and a workspace-cwd `npx`
// mis-resolves — so strip them and let subprocesses see a clean package-manager env (npmrc files are
// still honored, so a custom registry keeps working). Exported for testing.
export function cleanSubprocessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const cleaned: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(env)) {
        if (!/^(npm_|pnpm_)/i.test(key)) {
            cleaned[key] = value;
        }
    }
    return cleaned;
}

function shell(cmd: string, cwd?: string): { exitCode: number; stdout: string; stderr: string } {
    try {
        const stdout = execSync(cmd, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5 * 60 * 1000,
            // Commands are spawned without a TTY (piped stdio). Set CI so package managers run fully
            // non-interactively — without it, pnpm aborts rebuilding a clone's modules dir with
            // ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY when --ignore-workspace changes its link mode.
            // The env is cleaned so the invoking pnpm's config (minimum-release-age, etc.) can't leak in.
            env: { ...cleanSubprocessEnv(process.env), CI: 'true' }
        }).toString();
        return { exitCode: 0, stdout, stderr: '' };
    } catch (error: unknown) {
        const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer };
        return {
            exitCode: e.status ?? 1,
            stdout: e.stdout?.toString() ?? '',
            stderr: e.stderr?.toString() ?? ''
        };
    }
}

function runCheck(pm: string, pkgDir: string, checkType: string, override?: string | null): CheckResult {
    if (override === null) {
        return { exitCode: -1, stdout: '', stderr: 'skipped by manifest' };
    }

    let cmd: string;
    if (override) {
        cmd = override;
    } else {
        const detected = detectCheckCmd(pkgDir, checkType);
        if (!detected) {
            return { exitCode: -1, stdout: '', stderr: 'skipped: no matching script' };
        }
        cmd = detected === '__fallback_tsc' ? 'npx tsc --noEmit' : `${pm} run ${detected}`;
    }

    return shell(cmd, pkgDir);
}

function truncate(s: string, max = 50_000): string {
    return s.length > max ? s.slice(0, max) + '\n... (truncated)' : s;
}

// The published codemod CLI prints `Changes: <totalChanges> across <filesChanged> file(s)` ONLY when
// files changed (src/cli.ts:104); a no-op run prints the `No changes needed — …` line instead, and a
// diagnostics-only run prints neither. Best-effort: match the Changes line, else report zeros.
export function parseCodemodCliOutput(stdout: string): { filesChanged: number; totalChanges: number } {
    const m = stdout.match(/Changes:\s+(\d+)\s+across\s+(\d+)\s+file\(s\)/);
    if (m) {
        return { totalChanges: Number(m[1]), filesChanged: Number(m[2]) };
    }
    return { totalChanges: 0, filesChanged: 0 };
}

// Normalizes the two codemod execution paths. local = in-process run() (structured diagnostics);
// published = shell out to the pinned published CLI (raw stdout/stderr captured, diagnostics []).
export function runCodemod(source: Source, args: { migration: Migration; sourceDir: string; codemodVersion: string }): CodemodOutcome {
    if (source === 'local') {
        try {
            const r = run(args.migration, { targetDir: args.sourceDir, verbose: true });
            return { filesChanged: r.filesChanged, totalChanges: r.totalChanges, diagnostics: r.diagnostics };
        } catch (error) {
            console.log(`    ERROR: codemod threw: ${error}`);
            return { filesChanged: 0, totalChanges: 0, diagnostics: [] };
        }
    }

    // published: -p pins the exact resolved version; `mcp-codemod` is the bin, `v1-to-v2` the command.
    // A non-zero exit (the CLI flags error diagnostics) is recorded, not fatal.
    // SECURITY: see resolvePublishedVersion — interpolating codemodVersion/sourceDir here is safe ONLY
    // because both are operator-controlled (JSON.stringify does NOT stop $(…)/backticks under `sh -c`).
    const cmd = `npx -y -p @modelcontextprotocol/codemod@${args.codemodVersion} mcp-codemod v1-to-v2 ${JSON.stringify(args.sourceDir)} --verbose`;
    // npx must run OUTSIDE the SDK's pnpm workspace, or it resolves the workspace's own `mcp-codemod`
    // bin link instead of the published package and exits 127. tmpdir() is a neutral cwd; the codemod
    // target is an absolute path arg, so cwd doesn't affect what gets migrated.
    const result = shell(cmd, tmpdir());
    const counts = parseCodemodCliOutput(result.stdout);
    return {
        filesChanged: counts.filesChanged,
        totalChanges: counts.totalChanges,
        diagnostics: [],
        cli: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    };
}

// Maps a resolved config to its per-run results-directory leaf name: `<codemodSeg>__<sdkSeg>`. The codemod
// segment is `codemod-local` (local source) or `codemod-<resolved>`; the SDK segment is `sdk-local` (local),
// `sdk-<resolved>` when a representative version is known, else `sdk-from-codemod` (published, version unknown).
export function computeResultsDirName(resolved: ResolvedConfig): string {
    const codemodSeg = resolved.codemodSource === 'local' ? 'codemod-local' : `codemod-${resolved.codemodVersionResolved}`;

    let sdkSeg: string;
    if (resolved.sdkSource === 'local') {
        sdkSeg = 'sdk-local';
    } else if (resolved.sdkVersionResolved) {
        sdkSeg = `sdk-${resolved.sdkVersionResolved}`;
    } else {
        sdkSeg = 'sdk-from-codemod';
    }

    return `${codemodSeg}__${sdkSeg}`;
}

// Human-readable mode descriptor for the startup banner: `local`, or `published (<ver>)` /
// `published (from-codemod)` when the concrete version is only known after install.
function fmtMode(src: Source, ver: string | null): string {
    return src === 'local' ? 'local' : `published (${ver ?? 'from-codemod'})`;
}

function packLocalPackages(): Record<string, string> {
    mkdirSync(TARBALL_DIR, { recursive: true });

    const tarballs: Record<string, string> = {};
    for (const [name, pkgDir] of Object.entries(LOCAL_PACKAGE_DIRS)) {
        console.log(`  Packing ${name}...`);
        const result = shell(`pnpm pack --pack-destination ${JSON.stringify(TARBALL_DIR)}`, pkgDir);
        if (result.exitCode !== 0) {
            console.error(`  ERROR: failed to pack ${name}: ${result.stderr.split('\n')[0]}`);
            continue;
        }
        const tarballFile = result.stdout.trim().split('\n').pop()!;
        tarballs[name] = path.resolve(TARBALL_DIR, path.basename(tarballFile));
    }
    return tarballs;
}

function rewriteToLocalTarballs(pkgJsonPath: string, tarballs: Record<string, string>): number {
    const raw = readFileSync(pkgJsonPath, 'utf8');
    const pkgJson = JSON.parse(raw) as Record<string, unknown>;
    let rewrites = 0;

    for (const section of ['dependencies', 'devDependencies']) {
        const deps = pkgJson[section] as Record<string, string> | undefined;
        if (!deps) continue;
        for (const [name, tarballPath] of Object.entries(tarballs)) {
            if (name in deps) {
                deps[name] = `file:${tarballPath}`;
                rewrites++;
            }
        }
    }

    if (rewrites > 0) {
        const indent = raw.match(/^(\s+)"/m)?.[1] ?? '  ';
        const trailingNewline = raw.endsWith('\n');
        let output = JSON.stringify(pkgJson, null, indent);
        if (trailingNewline) output += '\n';
        writeFileSync(pkgJsonPath, output);
    }

    return rewrites;
}

export function parseNpmViewVersion(jsonText: string): string {
    const parsed = JSON.parse(jsonText) as string | string[];
    if (Array.isArray(parsed)) {
        if (parsed.length === 0) throw new Error('npm view returned an empty version array');
        // `npm view <pkg>@<range>` lists matches in publish order, so this is the most recently published
        // match — not necessarily the highest semver (a backport published after a newer release sorts last).
        // Adequate here: specs are normally an exact version or a dist-tag (both resolve to a single string
        // above), and the SDK packages publish in forward order; not worth a semver dependency for a dev-only
        // label. Revisit with a semver max if ranges over out-of-order publishes become common.
        return parsed.at(-1)!;
    }
    return parsed;
}

// Resolve a single package@spec to a concrete version via the registry. PM-agnostic (npm ships with
// Node). Throws so the caller can abort at startup before any repo work begins. Consumed in main()
// (Task 6); exported to keep it part of the module surface rather than an unused module-private fn.
// SECURITY: interpolating pkg@spec here (like the npx/git shell-outs elsewhere in this harness) is safe ONLY
// because every input is operator/maintainer-controlled — CLI flags, the committed repos.json, and
// Anthropic-published npm versions. JSON.stringify quoting does NOT neutralize $(…)/backticks under `sh -c`,
// so this harness must never be pointed at an untrusted manifest.
export function resolvePublishedVersion(pkg: string, spec: string): string {
    const result = shell(`npm view ${JSON.stringify(`${pkg}@${spec}`)} version --json`);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
        throw new Error(`Failed to resolve ${pkg}@${spec} via npm view: ${result.stderr.trim() || 'no output'}`);
    }
    return parseNpmViewVersion(result.stdout.trim());
}

// Pin each present v2 dependency to its OWN resolved version (packages are not lockstep). Mirrors
// rewriteToLocalTarballs' formatting preservation. Returns the rewrite count.
export function rewriteToPublishedVersion(pkgJsonPath: string, versionByPkg: Record<string, string>): number {
    const raw = readFileSync(pkgJsonPath, 'utf8');
    const pkgJson = JSON.parse(raw) as Record<string, unknown>;
    let rewrites = 0;

    for (const section of ['dependencies', 'devDependencies']) {
        const deps = pkgJson[section] as Record<string, string> | undefined;
        if (!deps) continue;
        for (const name of PUBLISHABLE_V2_PACKAGES) {
            if (name in deps && versionByPkg[name]) {
                deps[name] = versionByPkg[name]!;
                rewrites++;
            }
        }
    }

    if (rewrites > 0) {
        const indent = raw.match(/^(\s+)"/m)?.[1] ?? '  ';
        const trailingNewline = raw.endsWith('\n');
        let output = JSON.stringify(pkgJson, null, indent);
        if (trailingNewline) output += '\n';
        writeFileSync(pkgJsonPath, output);
    }

    return rewrites;
}

function getCheckOverride(checks: Record<string, string | null>, type: string): string | null | undefined {
    if (type in checks) return checks[type] ?? null;
    return undefined;
}

function isAllClean(checks: Record<string, CheckResult>): boolean {
    return Object.values(checks).every(c => c.exitCode === 0 || c.exitCode === -1);
}

function hasNewError(baseline: Record<string, CheckResult>, post: Record<string, CheckResult>, type: string): number {
    return baseline[type]!.exitCode === 0 && post[type]!.exitCode !== 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const CLONE_DIR = path.join(BATCH_DIR, 'repos');
const OUTPUT_DIR = path.join(BATCH_DIR, 'results');

function parseSource(flag: string, value: string | undefined): Source {
    if (value !== 'local' && value !== 'published') {
        throw new Error(`Invalid ${flag} value: ${value ?? '(missing)'}. Expected 'local' or 'published'.`);
    }
    return value;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): BatchTestOptions {
    // Support both `--flag value` and `--flag=value`; drop a bare `--` separator.
    const args = argv
        .filter(a => a !== '--')
        .flatMap(a => {
            if (a.startsWith('--') && a.includes('=')) {
                const idx = a.indexOf('=');
                return [a.slice(0, idx), a.slice(idx + 1)];
            }
            return [a];
        });

    const opts: BatchTestOptions = {
        manifest: path.join(BATCH_DIR, 'repos.json'),
        sdk: 'local',
        codemod: 'local',
        codemodVersion: 'latest'
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--manifest': {
                opts.manifest = args[++i]!;
                break;
            }
            case '--sdk': {
                opts.sdk = parseSource('--sdk', args[++i]);
                break;
            }
            case '--codemod': {
                opts.codemod = parseSource('--codemod', args[++i]);
                break;
            }
            case '--codemod-version': {
                opts.codemodVersion = args[++i]!;
                break;
            }
            case '--sdk-version': {
                opts.sdkVersion = args[++i]!;
                break;
            }
            default: {
                throw new Error(`Unknown flag: ${args[i]}`);
            }
        }
    }

    // A version override only applies to a published source; warn + ignore otherwise.
    if (opts.codemod === 'local' && args.includes('--codemod-version')) {
        console.warn('Warning: --codemod-version is ignored when --codemod=local');
    }
    if (opts.sdk === 'local' && opts.sdkVersion !== undefined) {
        console.warn('Warning: --sdk-version is ignored when --sdk=local');
    }

    return opts;
}

function main(): void {
    let opts: BatchTestOptions;
    try {
        opts = parseArgs();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }

    if (!existsSync(opts.manifest)) {
        console.error(`Error: manifest not found at ${opts.manifest}`);
        process.exit(1);
    }

    const migration = getMigration('v1-to-v2');
    if (!migration) {
        console.error('Error: v1-to-v2 migration not found');
        process.exit(1);
    }

    mkdirSync(CLONE_DIR, { recursive: true });
    mkdirSync(OUTPUT_DIR, { recursive: true });

    const manifest: RepoEntry[] = JSON.parse(readFileSync(opts.manifest, 'utf8')) as RepoEntry[];
    const codemodPkg = JSON.parse(readFileSync(path.join(SDK_ROOT, 'packages/codemod/package.json'), 'utf8')) as { version: string };
    const codemodVersion = codemodPkg.version;
    const codemodCommit = execSync('git rev-parse --short HEAD', { cwd: SDK_ROOT }).toString().trim();
    const timestamp = new Date().toISOString();

    console.log('=== Codemod Batch Test ===');
    console.log(`Manifest: ${opts.manifest} (${manifest.length} repos)`);
    console.log(`Codemod: v${codemodVersion} (${codemodCommit})`);
    console.log('');

    const SERVER_PKG = '@modelcontextprotocol/server';

    // Resolve published versions once, up front. A codemod-version or representative-label miss aborts here;
    // a per-package --sdk-version miss is tolerated with a warning (see the resolve loop below).
    let resolved: ResolvedConfig;
    const sdkVersions: Record<string, string> = {};
    try {
        const codemodVersionResolved =
            opts.codemod === 'published' ? resolvePublishedVersion('@modelcontextprotocol/codemod', opts.codemodVersion) : null;

        let sdkVersionResolved: string | null = null;
        if (opts.sdk === 'published') {
            if (opts.sdkVersion !== undefined) {
                // Force-pin: resolve EACH publishable package independently against the requested spec.
                // The SDK packages are NOT lockstep, so a given version may be missing for one package
                // (e.g. @modelcontextprotocol/core's latest is alpha.1 while the rest have alpha.3). Tolerate
                // a per-package miss with a warning + continue — mirroring packLocalPackages' per-pack
                // tolerance — instead of aborting the whole run. A skipped package is left out of sdkVersions,
                // so rewriteToPublishedVersion keeps whatever range the codemod wrote for it.
                for (const pkg of PUBLISHABLE_V2_PACKAGES) {
                    try {
                        sdkVersions[pkg] = resolvePublishedVersion(pkg, opts.sdkVersion);
                    } catch {
                        console.warn(`Warning: ${pkg}@${opts.sdkVersion} did not resolve; leaving its codemod-written range in place.`);
                    }
                }
                sdkVersionResolved = sdkVersions[SERVER_PKG] ?? null; // representative label
            } else if (opts.codemod === 'local') {
                // Unset version + local codemod: the codemod writes its bundled ranges; resolve the server
                // range to a concrete version for the directory label only (no rewrite).
                sdkVersionResolved = resolvePublishedVersion(SERVER_PKG, V2_PACKAGE_VERSIONS[SERVER_PKG]!);
            }
            // else (unset + published codemod): version is unknown until install → sdk-from-codemod.
        }

        resolved = {
            codemodSource: opts.codemod,
            sdkSource: opts.sdk,
            codemodVersionSpec: opts.codemodVersion,
            codemodVersionResolved,
            sdkVersionSpec: opts.sdkVersion ?? null,
            sdkVersionResolved,
            resultsDir: '' // filled next
        };
        resolved.resultsDir = `results/${computeResultsDirName(resolved)}`;
    } catch (error) {
        console.error(`Error resolving published versions: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }

    const runOutputDir = path.join(OUTPUT_DIR, computeResultsDirName(resolved));
    mkdirSync(runOutputDir, { recursive: true });

    console.log(
        `Codemod: ${fmtMode(resolved.codemodSource, resolved.codemodVersionResolved)} | SDK: ${fmtMode(resolved.sdkSource, resolved.sdkVersionResolved)}`
    );
    console.log(`Results: ${runOutputDir}\n`);

    let tarballs: Record<string, string> = {};
    if (resolved.sdkSource === 'local') {
        console.log('--- Packing local SDK packages ---');
        tarballs = packLocalPackages();
        console.log(`  Packed ${Object.keys(tarballs).length} packages\n`);
    } else {
        console.log('Skipping local pack (SDK source: published)\n');
    }

    const summaryResults: SummaryEntry[] = [];
    // Actually-installed versions for summary.sdkVersions — seeded from the startup-resolved pins and refined
    // per-repo from node_modules below. Kept SEPARATE from `sdkVersions` (the immutable pinning map) so a
    // package left unpinned at startup is not retroactively pinned for later repos from an earlier install.
    const installedVersions: Record<string, string> = { ...sdkVersions };
    let totalPackages = 0;

    for (let i = 0; i < manifest.length; i++) {
        const entry = manifest[i]!;
        const ref = entry.ref ?? 'main';
        const repoSlug = entry.repo.replace('/', '_');
        const clonePath = path.join(CLONE_DIR, repoSlug);

        console.log(`--- [${i + 1}/${manifest.length}] ${entry.repo} (${ref}) ---`);

        // Step 1: Clone or reset
        if (existsSync(path.join(clonePath, '.git'))) {
            console.log('  Resetting existing clone...');
            // --staged --worktree reverts both the index and the working tree to HEAD: a prior run's
            // migration can end up staged (e.g. a target repo's own pre-commit / lint-staged hooks), and a
            // worktree-only `git restore .` can't undo a staged change, leaving a stale migrated clone.
            shell('git restore --staged --worktree .', clonePath);
            shell('git clean -fd', clonePath);
        } else {
            console.log('  Cloning...');
            const cloneResult = shell(
                `git clone --depth 1 --branch ${ref} https://github.com/${entry.repo}.git ${JSON.stringify(clonePath)}`
            );
            if (cloneResult.exitCode !== 0) {
                console.log(`  ERROR: clone failed, skipping\n  ${cloneResult.stderr.split('\n')[0]}`);
                continue;
            }
        }

        // Step 2: Detect package manager
        const pm = detectPm(clonePath);
        console.log(`  Package manager: ${pm}`);

        // Process packages
        const packages: PackageEntry[] = entry.packages ?? [{ dir: '.', sourceDir: 'src' }];
        const repoPkgResults: PackageReport[] = [];

        // Step 3: Install. A clone that is its own pnpm workspace (catalog:/workspace: deps) must keep its
        // pnpm-workspace.yaml — see installCommand. Computed once and reused for the post-codemod reinstall.
        const installCmd = installCommand(pm, {
            hasOwnPnpmWorkspace: existsSync(path.join(clonePath, 'pnpm-workspace.yaml')),
            packageDirs: packages.map(p => p.dir)
        });
        console.log('  Installing dependencies...');
        const installResult = shell(installCmd, clonePath);
        if (installResult.exitCode !== 0) {
            console.log(`  ERROR: install failed, skipping\n  ${installResult.stderr.split('\n')[0]}`);
            continue;
        }

        for (const pkg of packages) {
            const sourceDir = pkg.sourceDir ?? 'src';
            const fullPkgDir = path.join(clonePath, pkg.dir);
            const fullSourceDir = path.join(fullPkgDir, sourceDir);

            console.log(`  Package: ${pkg.dir} (source: ${sourceDir})`);

            const checks = pkg.checks ?? {};

            // Step 4: Baseline checks
            console.log('    Running baseline checks...');
            const baseline: Record<string, CheckResult> = {};
            for (const checkType of ['typecheck', 'build', 'test', 'lint']) {
                baseline[checkType] = runCheck(pm, fullPkgDir, checkType, getCheckOverride(checks, checkType));
            }
            console.log(
                `    Baseline: tc=${baseline['typecheck']!.exitCode} build=${baseline['build']!.exitCode} test=${baseline['test']!.exitCode} lint=${baseline['lint']!.exitCode}`
            );

            // Step 5: Run codemod (local in-process API, or published CLI)
            console.log('    Running codemod...');
            const codemodOutcome = runCodemod(resolved.codemodSource, {
                migration,
                sourceDir: fullSourceDir,
                codemodVersion: resolved.codemodVersionResolved ?? ''
            });
            console.log(
                `    Codemod: files=${codemodOutcome.filesChanged} changes=${codemodOutcome.totalChanges} diags=${codemodOutcome.diagnostics.length}` +
                    (codemodOutcome.cli ? ` cliExit=${codemodOutcome.cli.exitCode}` : '')
            );

            // Step 6: Point the clone's v2 deps at the chosen SDK source, then re-install
            if (resolved.sdkSource === 'local') {
                const rewrites = rewriteToLocalTarballs(path.join(fullPkgDir, 'package.json'), tarballs);
                if (rewrites > 0) console.log(`    Rewrote ${rewrites} deps to local tarballs`);
            } else if (resolved.sdkVersionSpec === null) {
                console.log('    Leaving codemod-written dependency ranges (SDK: published, version from codemod)');
            } else {
                const rewrites = rewriteToPublishedVersion(path.join(fullPkgDir, 'package.json'), sdkVersions);
                if (rewrites > 0) console.log(`    Pinned ${rewrites} deps to resolved published versions`);
            }
            console.log('    Re-installing dependencies...');
            shell(installCmd, clonePath);

            // Step 7: Post-codemod checks
            console.log('    Running post-codemod checks...');
            const postCodemod: Record<string, CheckResult> = {};
            for (const checkType of ['typecheck', 'build', 'test', 'lint']) {
                postCodemod[checkType] = runCheck(pm, fullPkgDir, checkType, getCheckOverride(checks, checkType));
            }
            console.log(
                `    Post:     tc=${postCodemod['typecheck']!.exitCode} build=${postCodemod['build']!.exitCode} test=${postCodemod['test']!.exitCode} lint=${postCodemod['lint']!.exitCode}`
            );

            // Record the actually-installed SDK versions (best-effort) so summary.sdkVersions is truthful for
            // every mode: published-pinned, sdk-from-codemod (versions only known post-install), and local (the
            // workspace versions packed into the tarballs the clone depends on). Recorded into `installedVersions`
            // and NOT back into the startup-resolved `sdkVersions` pins: writing into the pinning map would
            // retroactively pin a startup-unresolved package for every later repo to whatever the first repo
            // happened to install. Done AFTER the checks because a monorepo target's deps are installed into
            // <pkg.dir>/node_modules by the check command itself — the Step-6 reinstall runs at the clone root
            // and, under --ignore-workspace, never touches a subdirectory package. Resolve against the package's
            // node_modules first, then fall back to the clone root for hoisted single-package layouts; for a root
            // package (pkg.dir = '.') the two coincide (deduped). The summary's `config` records the SDK source,
            // so a bare version here is unambiguous.
            for (const sdkPkg of PUBLISHABLE_V2_PACKAGES) {
                const candidates = [
                    ...new Set([
                        path.join(fullPkgDir, 'node_modules', sdkPkg, 'package.json'),
                        path.join(clonePath, 'node_modules', sdkPkg, 'package.json')
                    ])
                ];
                for (const candidate of candidates) {
                    try {
                        const installed = JSON.parse(readFileSync(candidate, 'utf8')) as { version: string };
                        installedVersions[sdkPkg] = installed.version;
                        break;
                    } catch {
                        // not installed at this location — try the next candidate
                    }
                }
            }

            // Truncate large outputs for the report
            for (const r of [...Object.values(baseline), ...Object.values(postCodemod)]) {
                r.stdout = truncate(r.stdout);
                r.stderr = truncate(r.stderr);
            }

            repoPkgResults.push({
                dir: pkg.dir,
                sourceDir,
                codemod: {
                    filesChanged: codemodOutcome.filesChanged,
                    totalChanges: codemodOutcome.totalChanges,
                    diagnostics: codemodOutcome.diagnostics,
                    ...(codemodOutcome.cli
                        ? {
                              cli: {
                                  exitCode: codemodOutcome.cli.exitCode,
                                  stdout: truncate(codemodOutcome.cli.stdout),
                                  stderr: truncate(codemodOutcome.cli.stderr)
                              }
                          }
                        : {})
                },
                baseline,
                postCodemod
            });
            totalPackages++;

            summaryResults.push({
                repo: entry.repo,
                package: pkg.dir,
                baselineClean: isAllClean(baseline),
                postCodemodClean: isAllClean(postCodemod),
                newErrors: {
                    typecheck: hasNewError(baseline, postCodemod, 'typecheck'),
                    build: hasNewError(baseline, postCodemod, 'build'),
                    test: hasNewError(baseline, postCodemod, 'test'),
                    lint: hasNewError(baseline, postCodemod, 'lint')
                },
                codemodDiagnostics: {
                    warning: codemodOutcome.diagnostics.filter(d => d.level === 'warning').length,
                    error: codemodOutcome.diagnostics.filter(d => d.level === 'error').length,
                    info: codemodOutcome.diagnostics.filter(d => d.level === 'info').length
                }
            });
        }

        // Step 8: Write per-repo report (nested under the per-run results dir)
        const repoOutputDir = path.join(runOutputDir, repoSlug);
        mkdirSync(repoOutputDir, { recursive: true });

        const report: RepoReport = {
            repo: entry.repo,
            ref,
            timestamp,
            packageManager: pm,
            packages: repoPkgResults
        };
        writeFileSync(path.join(repoOutputDir, 'report.json'), JSON.stringify(report, null, 2));
        console.log(`  Report: ${repoOutputDir}/report.json\n`);
    }

    // Write summary
    const reposClean = summaryResults.filter(r => r.postCodemodClean).length;
    const reposWithErrors = summaryResults.filter(r => !r.postCodemodClean).length;
    const totalNewTc = summaryResults.reduce((sum, r) => sum + r.newErrors['typecheck']!, 0);
    const totalWarnings = summaryResults.reduce((sum, r) => sum + r.codemodDiagnostics['warning']!, 0);

    const summary: Summary = {
        timestamp,
        codemodVersion,
        codemodCommit,
        config: {
            codemodSource: resolved.codemodSource,
            sdkSource: resolved.sdkSource,
            codemodVersionSpec: resolved.codemodVersionSpec,
            codemodVersionResolved: resolved.codemodVersionResolved,
            sdkVersionSpec: resolved.sdkVersionSpec,
            sdkVersionResolved: resolved.sdkVersionResolved,
            resultsDir: resolved.resultsDir
        },
        sdkVersions: installedVersions,
        totalRepos: manifest.length,
        totalPackages,
        results: summaryResults,
        aggregated: {
            reposClean,
            reposWithNewErrors: reposWithErrors,
            totalNewTypecheckErrors: totalNewTc,
            totalCodemodWarnings: totalWarnings
        }
    };
    writeFileSync(path.join(runOutputDir, 'summary.json'), JSON.stringify(summary, null, 2));

    console.log('=== Summary ===');
    console.log(`Repos: ${manifest.length} | Packages: ${totalPackages}`);
    console.log(`Clean after codemod: ${reposClean} | With new errors: ${reposWithErrors}`);
    console.log(`New typecheck errors: ${totalNewTc} | Codemod warnings: ${totalWarnings}`);
    console.log('');
    console.log(`Results: ${runOutputDir}/summary.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
