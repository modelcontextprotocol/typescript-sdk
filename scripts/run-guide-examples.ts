#!/usr/bin/env tsx
/**
 * Run every guide companion under `examples/guides/**` as a real program.
 *
 * Each docs page's code fences are synced from a companion
 * `examples/guides/<...>/<page>.examples.ts` (see `scripts/sync-snippets.ts`).
 * Companions that quote output are self-verifying top-level-await scripts: they
 * drive an in-memory client/server pair (or a web-standard `handler.fetch`),
 * assert what the page claims, and exit non-zero on any mismatch. This harness
 * runs each one with `tsx` and reports PASS/FAIL from the child's exit code.
 *
 * A companion with nothing meaningful to execute opts out by making its FIRST
 * line exactly:
 *
 *     // docs: typecheck-only
 *
 * Those files are still type-checked by the `@modelcontextprotocol/examples`
 * package; they are listed here as SKIP and never spawned.
 *
 * Files run SEQUENTIALLY (they are cheap, and this avoids any port/stdin
 * contention). A run that exceeds the per-file timeout is a FAIL ("hung —
 * possible unclosed handle"): companions must terminate on their own, so they
 * never bind a port and never block on stdin (stdin is closed for the child).
 */
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GUIDES = join(ROOT, 'examples', 'guides');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

/** Marker that opts a companion out of being executed (first line, exact). */
const TYPECHECK_ONLY = '// docs: typecheck-only';

/** Per-file timeout: a companion that has not exited by now is hung. */
const TIMEOUT_MS = 90_000;

interface FileResult {
    file: string;
    ok: boolean;
    durationMs: number;
    detail: string;
}

function isTypecheckOnly(file: string): boolean {
    const firstLine = readFileSync(file, 'utf8').split('\n', 1)[0] ?? '';
    return firstLine.trimEnd() === TYPECHECK_ONLY;
}

function runOne(file: string): Promise<FileResult> {
    const started = Date.now();
    return new Promise(resolvePromise => {
        // stdin is 'ignore' so a companion that (incorrectly) reads stdin sees
        // EOF immediately instead of hanging until the timeout.
        const child = spawn(TSX, [file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', d => (output += String(d)));
        child.stderr.on('data', d => (output += String(d)));
        const finish = (ok: boolean, detail: string): void => resolvePromise({ file, ok, durationMs: Date.now() - started, detail });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish(false, `timed out after ${TIMEOUT_MS / 1000}s (hung — possible unclosed handle)\n${output}`);
        }, TIMEOUT_MS);
        child.on('close', code => {
            clearTimeout(timer);
            if (code === 0) finish(true, '');
            else finish(false, `exit ${code}\n${output}`);
        });
        child.on('error', err => {
            clearTimeout(timer);
            finish(false, `spawn error: ${err.message}\n${output}`);
        });
    });
}

async function main(): Promise<void> {
    const files = readdirSync(GUIDES, { recursive: true, encoding: 'utf8' })
        .filter(name => name.endsWith('.examples.ts'))
        .map(name => join(GUIDES, name))
        .sort();
    if (files.length === 0) {
        console.error(`No *.examples.ts files found under ${GUIDES}`);
        process.exit(1);
    }

    const results: FileResult[] = [];
    let skipped = 0;
    for (const file of files) {
        const name = relative(ROOT, file);
        if (isTypecheckOnly(file)) {
            skipped++;
            console.log(`SKIP ${name} (typecheck-only)`);
            continue;
        }
        const result = await runOne(file);
        results.push(result);
        console.log(`${result.ok ? 'PASS' : 'FAIL'} ${name} (${(result.durationMs / 1000).toFixed(1)}s)`);
        if (!result.ok) console.log(result.detail);
    }

    const failed = results.filter(r => !r.ok);
    console.log('\n=== guide examples summary ===');
    console.log(`files: ${results.length} run / ${skipped} typecheck-only / ${failed.length} failed`);
    for (const r of failed) console.log(`  FAIL ${relative(ROOT, r.file)}`);

    process.exit(failed.length === 0 ? 0 : 1);
}

void main();
