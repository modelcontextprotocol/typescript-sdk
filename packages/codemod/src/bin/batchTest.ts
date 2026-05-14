#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getMigration } from '../migrations/index.js';
import { run } from '../runner.js';
import type { Diagnostic, RunnerResult } from '../types.js';

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

interface Summary {
    timestamp: string;
    codemodVersion: string;
    codemodCommit: string;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const SDK_ROOT = path.resolve(SCRIPT_DIR, '../../../..');
const BATCH_DIR = path.resolve(SDK_ROOT, 'packages/codemod/batch-test');

const LOCAL_PACKAGE_DIRS: Record<string, string> = {
    '@modelcontextprotocol/client': path.join(SDK_ROOT, 'packages/client'),
    '@modelcontextprotocol/core': path.join(SDK_ROOT, 'packages/core'),
    '@modelcontextprotocol/server': path.join(SDK_ROOT, 'packages/server'),
    '@modelcontextprotocol/express': path.join(SDK_ROOT, 'packages/middleware/express'),
    '@modelcontextprotocol/fastify': path.join(SDK_ROOT, 'packages/middleware/fastify'),
    '@modelcontextprotocol/hono': path.join(SDK_ROOT, 'packages/middleware/hono'),
    '@modelcontextprotocol/node': path.join(SDK_ROOT, 'packages/middleware/node')
};

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

function shell(cmd: string, cwd?: string): { exitCode: number; stdout: string; stderr: string } {
    try {
        const stdout = execSync(cmd, {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 10 * 1024 * 1024,
            timeout: 5 * 60 * 1000
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

function parseArgs(): { manifest: string } {
    const args = process.argv.slice(2).filter(a => a !== '--');
    const opts = {
        manifest: path.join(BATCH_DIR, 'repos.json')
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--manifest': {
                opts.manifest = args[++i]!;
                break;
            }
            default: {
                console.error(`Unknown flag: ${args[i]}`);
                process.exit(1);
            }
        }
    }
    return opts;
}

function main(): void {
    const opts = parseArgs();

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

    console.log('--- Packing local SDK packages ---');
    const tarballs = packLocalPackages();
    console.log(`  Packed ${Object.keys(tarballs).length} packages\n`);

    const summaryResults: SummaryEntry[] = [];
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
            shell('git restore .', clonePath);
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

        // Step 3: Install
        console.log('  Installing dependencies...');
        const installResult = shell(`${pm} install --ignore-scripts`, clonePath);
        if (installResult.exitCode !== 0) {
            console.log(`  ERROR: install failed, skipping\n  ${installResult.stderr.split('\n')[0]}`);
            continue;
        }

        // Process packages
        const packages: PackageEntry[] = entry.packages ?? [{ dir: '.', sourceDir: 'src' }];
        const repoPkgResults: PackageReport[] = [];

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

            // Step 5: Run codemod (programmatic API)
            console.log('    Running codemod...');
            let codemodResult: RunnerResult;
            try {
                codemodResult = run(migration, { targetDir: fullSourceDir, verbose: true });
            } catch (error) {
                console.log(`    ERROR: codemod threw: ${error}`);
                codemodResult = { filesChanged: 0, totalChanges: 0, diagnostics: [], fileResults: [] };
            }
            console.log(
                `    Codemod: files=${codemodResult.filesChanged} changes=${codemodResult.totalChanges} diags=${codemodResult.diagnostics.length}`
            );

            // Step 6: Rewrite v2 deps to local tarballs, then re-install
            const rewrites = rewriteToLocalTarballs(path.join(fullPkgDir, 'package.json'), tarballs);
            if (rewrites > 0) {
                console.log(`    Rewrote ${rewrites} deps to local tarballs`);
            }
            console.log('    Re-installing dependencies...');
            shell(`${pm} install --ignore-scripts`, clonePath);

            // Step 7: Post-codemod checks
            console.log('    Running post-codemod checks...');
            const postCodemod: Record<string, CheckResult> = {};
            for (const checkType of ['typecheck', 'build', 'test', 'lint']) {
                postCodemod[checkType] = runCheck(pm, fullPkgDir, checkType, getCheckOverride(checks, checkType));
            }
            console.log(
                `    Post:     tc=${postCodemod['typecheck']!.exitCode} build=${postCodemod['build']!.exitCode} test=${postCodemod['test']!.exitCode} lint=${postCodemod['lint']!.exitCode}`
            );

            // Truncate large outputs for the report
            for (const r of [...Object.values(baseline), ...Object.values(postCodemod)]) {
                r.stdout = truncate(r.stdout);
                r.stderr = truncate(r.stderr);
            }

            repoPkgResults.push({
                dir: pkg.dir,
                sourceDir,
                codemod: {
                    filesChanged: codemodResult.filesChanged,
                    totalChanges: codemodResult.totalChanges,
                    diagnostics: codemodResult.diagnostics
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
                    warning: codemodResult.diagnostics.filter(d => d.level === 'warning').length,
                    error: codemodResult.diagnostics.filter(d => d.level === 'error').length,
                    info: codemodResult.diagnostics.filter(d => d.level === 'info').length
                }
            });
        }

        // Step 8: Write per-repo report
        const repoOutputDir = path.join(OUTPUT_DIR, repoSlug);
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
    writeFileSync(path.join(OUTPUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

    console.log('=== Summary ===');
    console.log(`Repos: ${manifest.length} | Packages: ${totalPackages}`);
    console.log(`Clean after codemod: ${reposClean} | With new errors: ${reposWithErrors}`);
    console.log(`New typecheck errors: ${totalNewTc} | Codemod warnings: ${totalWarnings}`);
    console.log('');
    console.log(`Results: ${OUTPUT_DIR}/summary.json`);
}

main();
