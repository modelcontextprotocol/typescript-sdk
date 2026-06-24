#!/usr/bin/env tsx
/**
 * Build-and-e2e-run every story under `examples/` over every transport × era
 * leg it supports. Each story's `client.ts` is a self-verifying top-level-await
 * script: a `check.*` failure throws, Node prints the error and exits 1; on
 * success `client.close()` releases the last handle and Node exits 0. The
 * harness reports PASS/FAIL from the child's exit code (a timeout is a FAIL
 * with "hung — possible unclosed handle").
 *
 *   - **stdio** (default for dual-transport stories): run `client.ts` with no
 *     transport flag; it spawns the sibling server binary itself and speaks
 *     MCP over the pipe.
 *   - **HTTP**: start `server.ts --http --port <P>`, poll until ready, run
 *     `client.ts --http http://127.0.0.1:<P>/<path>`, kill the server.
 *   - **modern** (default): the client negotiates the 2026-07-28 era
 *     (`versionNegotiation: { mode: 'auto' }`).
 *   - **legacy**: pass `--legacy` to the client so it uses the 2025
 *     `initialize` handshake (`versionNegotiation: { mode: 'legacy' }`).
 *
 * Per-story configuration lives in the story's `package.json` under the
 * `"example"` field — most stories have none. `excluded` stories are listed
 * (with their reason) but not run. Stories without a `client.ts` are skipped.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';

type Era = 'modern' | 'legacy';
type Transport = 'stdio' | 'http';

interface ExampleConfig {
    /** Transports to run (default: `['stdio', 'http']`). */
    transports?: Transport[];
    /** `'dual'` (modern + legacy; the default), `'modern'`, or `'legacy'`. */
    era?: 'dual' | Era;
    /** HTTP port (default: a per-story port assigned below). */
    port?: number;
    /** Endpoint path (default: `'/mcp'`). */
    path?: string;
    /** Extra environment for the server process. */
    env?: Record<string, string>;
    /** Per-leg timeout in milliseconds (default: 30000). */
    timeoutMs?: number;
    /** Optional substring the client's stdout must contain. */
    expects?: { stdout?: string };
    /** When present, the story is skipped (with this reason printed). */
    excluded?: string;
}

const ROOT = resolve(import.meta.dirname, '../..');
const EXAMPLES = join(ROOT, 'examples');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');

/** Directories that are never stories. */
const NON_STORY = new Set(['shared', 'guides', 'server-quickstart', 'client-quickstart', 'node_modules']);

/** Distinct per-story HTTP ports so the servers never collide. */
let nextPort = 8530;
const portFor = new Map<string, number>();
function assignPort(story: string, config: ExampleConfig): number {
    if (config.port) return config.port;
    if (!portFor.has(story)) portFor.set(story, nextPort++);
    return portFor.get(story)!;
}

function readConfig(dir: string): ExampleConfig {
    const file = join(dir, 'package.json');
    if (!existsSync(file)) return {};
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { example?: ExampleConfig };
    return pkg.example ?? {};
}

function run(
    cmd: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string>; timeoutMs: number }
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    return new Promise(resolvePromise => {
        const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => (stdout += String(d)));
        child.stderr.on('data', d => (stderr += String(d)));
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolvePromise({ code: 124, stdout, stderr: stderr + '\n[harness] timed out', timedOut: true });
        }, opts.timeoutMs);
        child.on('close', code => {
            clearTimeout(timer);
            resolvePromise({ code: code ?? 1, stdout, stderr, timedOut: false });
        });
        child.on('error', err => {
            clearTimeout(timer);
            resolvePromise({ code: 1, stdout, stderr: stderr + `\n[harness] spawn error: ${err.message}`, timedOut: false });
        });
    });
}

/**
 * Story `client.ts` files are top-level-await scripts: a thrown `check.*`
 * propagates as an unhandled rejection (Node prints + exits 1); a clean run
 * exits 0 once `client.close()` releases the last handle. The harness prints
 * PASS/FAIL itself from the child's exit code — there is no in-band OK/FAIL
 * line. A timeout means the process never exited on its own and is reported as
 * a hang (possible unclosed handle).
 */
function toLegResult(
    story: string,
    leg: string,
    result: { code: number; stdout: string; stderr: string; timedOut: boolean },
    config: ExampleConfig,
    serverLog?: string
): LegResult {
    if (result.timedOut) {
        return { story, leg, ok: false, detail: `(hung — possible unclosed handle)\n${result.stderr || result.stdout}${serverLog ?? ''}` };
    }
    const ok = result.code === 0 && (!config.expects?.stdout || result.stdout.includes(config.expects.stdout));
    return {
        story,
        leg,
        ok,
        detail: ok
            ? (result.stdout.trim().split('\n').pop() ?? '')
            : `exit ${result.code}\n${result.stderr || result.stdout}${serverLog ?? ''}`
    };
}

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await new Promise<boolean>(resolvePromise => {
            const sock = connect({ port, host: '127.0.0.1' }, () => {
                sock.destroy();
                resolvePromise(true);
            });
            sock.on('error', () => resolvePromise(false));
        });
        if (ok) return true;
        await new Promise(r => setTimeout(r, 200));
    }
    return false;
}

interface LegResult {
    story: string;
    leg: string;
    ok: boolean;
    detail: string;
}

const eraArgs = (era: Era): string[] => (era === 'legacy' ? ['--legacy'] : []);

async function runStdioLeg(story: string, dir: string, config: ExampleConfig, era: Era): Promise<LegResult> {
    const timeoutMs = config.timeoutMs ?? 30_000;
    const result = await run(TSX, [join(dir, 'client.ts'), ...eraArgs(era)], { cwd: ROOT, timeoutMs });
    return toLegResult(story, `stdio/${era}`, result, config);
}

async function runHttpLeg(story: string, dir: string, config: ExampleConfig, era: Era): Promise<LegResult> {
    const timeoutMs = config.timeoutMs ?? 30_000;
    const port = assignPort(story, config);
    const path = config.path ?? '/mcp';
    const url = `http://127.0.0.1:${port}${path}`;
    let serverStderr = '';
    const server: ChildProcess = spawn(TSX, [join(dir, 'server.ts'), '--http', '--port', String(port)], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port), ...config.env }
    });
    server.stderr?.on('data', d => (serverStderr += String(d)));
    server.stdout?.on('data', d => (serverStderr += String(d)));
    try {
        const ready = await waitForPort(port, 15_000);
        if (!ready) {
            return { story, leg: `http/${era}`, ok: false, detail: `server never bound :${port}\n--- server log ---\n${serverStderr}` };
        }
        const result = await run(TSX, [join(dir, 'client.ts'), '--http', url, ...eraArgs(era)], { cwd: ROOT, timeoutMs });
        return toLegResult(story, `http/${era}`, result, config, `\n--- server log ---\n${serverStderr}`);
    } finally {
        server.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 100));
        // `.killed` flips true the moment kill() is called, so it can't gate
        // the backstop; check whether the process actually exited instead.
        if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    }
}

async function main(): Promise<void> {
    const stories = readdirSync(EXAMPLES, { withFileTypes: true })
        .filter(d => d.isDirectory() && !NON_STORY.has(d.name))
        .map(d => d.name)
        .filter(name => existsSync(join(EXAMPLES, name, 'client.ts')))
        .sort();

    const results: LegResult[] = [];
    const excluded: Array<{ story: string; reason: string }> = [];

    for (const story of stories) {
        const dir = join(EXAMPLES, story);
        const config = readConfig(dir);
        if (config.excluded) {
            excluded.push({ story, reason: config.excluded });
            console.log(`\n::group::example ${story}\nSKIPPED: ${config.excluded}\n::endgroup::`);
            continue;
        }
        const transports: Transport[] = config.transports ?? ['stdio', 'http'];
        const era = config.era ?? 'dual';
        const eras: Era[] = era === 'dual' ? ['modern', 'legacy'] : [era];
        console.log(`\n::group::example ${story} (${transports.join('+')} × ${era})`);
        for (const t of transports) {
            for (const e of eras) {
                const r = t === 'stdio' ? await runStdioLeg(story, dir, config, e) : await runHttpLeg(story, dir, config, e);
                results.push(r);
                console.log(`[${r.leg}] ${r.ok ? 'PASS' : 'FAIL'}: ${r.detail.split('\n')[0]}`);
                if (!r.ok) console.log(r.detail);
            }
        }
        console.log('::endgroup::');
    }

    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok);
    console.log('\n=== examples e2e summary ===');
    console.log(`stories: ${stories.length - excluded.length} run / ${excluded.length} excluded`);
    console.log(`legs:    ${passed} passed / ${failed.length} failed`);
    for (const r of failed) console.log(`  FAIL ${r.story} [${r.leg}]`);
    for (const e of excluded) console.log(`  SKIP ${e.story}: ${e.reason}`);

    process.exit(failed.length === 0 ? 0 : 1);
}

void main();
