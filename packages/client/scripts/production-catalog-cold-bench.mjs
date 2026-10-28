/**
 * Optional cold-process benchmark for the production-catalog fixture.
 *
 * Not part of the normal test run. Timings are this process's measurements.
 * The eager arm precompiles every output schema on the same validator the
 * client then uses. It is a local control, not the published 2.3.1 package.
 *
 *   pnpm run bench:production-catalog
 *
 * Writes JSON to PRODUCTION_CATALOG_BENCH_RECEIPT when that path is set.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recoveryOutput } from '../test/client/fixtures/production-catalog/catalog-session.mjs';
import { loadProductionCatalog } from '../test/client/fixtures/production-catalog/load-catalog.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..');
const repoRoot = join(packageRoot, '../..');
const fixture = join(packageRoot, 'test/client/fixtures/production-catalog/catalog-session.mjs');
const PAIRS = [
    ['eager', 'candidate'],
    ['candidate', 'eager'],
    ['eager', 'candidate'],
    ['candidate', 'eager'],
    ['eager', 'candidate']
];

function sha256(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function sample(label) {
    const status = readFileSync('/proc/self/status', 'utf8');
    const rssKiB = Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? '0');
    const memory = process.memoryUsage();
    return { label, rssKiB, heapUsed: memory.heapUsed, rss: memory.rss };
}

function recordingEngine(Ajv2020, addFormats) {
    const ajv = new Ajv2020({ strict: false, validateFormats: true, validateSchema: false, allErrors: true });
    addFormats(ajv);
    const engine = {
        compiles: 0,
        compile(schema) {
            engine.compiles += 1;
            return ajv.compile(schema);
        },
        getSchema(keyRef) {
            return ajv.getSchema(keyRef);
        },
        errorsText(errors) {
            return ajv.errorsText(errors);
        }
    };
    return engine;
}

class CountingValidator {
    preparations = 0;
    schemas = [];

    constructor(inner) {
        this.inner = inner;
    }

    getValidator(schema) {
        this.preparations += 1;
        this.schemas.push(schema);
        return this.inner.getValidator(schema);
    }
}

function git(args) {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

async function runTrial(arm, mode) {
    const { Client } = await import('../dist/index.mjs');
    const { getDefaultEnvironment, StdioClientTransport } = await import('../dist/stdio.mjs');
    const { addFormats, AjvJsonSchemaValidator } = await import('../dist/validators/ajv.mjs');
    const { Ajv2020 } = await import('ajv/dist/2020.js');
    const catalog = loadProductionCatalog();
    const engine = recordingEngine(Ajv2020, addFormats);
    const counting = new CountingValidator(new AjvJsonSchemaValidator(engine));
    let changed;
    const client = new Client(
        { name: 'production-catalog-bench', version: '211240' },
        {
            capabilities: {},
            jsonSchemaValidator: counting,
            listChanged: {
                tools: {
                    debounceMs: 0,
                    onChanged(error, items) {
                        changed = { error: error === null ? null : String(error.message), count: items?.length ?? null };
                    }
                }
            }
        }
    );
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fixture],
        env: { ...getDefaultEnvironment(), FIXTURE_MODE: mode },
        stderr: 'pipe'
    });
    let stderr = '';
    transport.stderr?.on('data', chunk => {
        stderr += chunk.toString();
    });
    const boundaries = [sample('process-start')];
    const setupStarted = performance.now();
    await client.connect(transport);
    const listed = await client.listTools();
    const setupMs = performance.now() - setupStarted;
    boundaries.push(sample('after-discovery'));

    async function oneCall(label) {
        const preparationsBefore = counting.preparations;
        const compilesBefore = engine.compiles;
        const started = performance.now();
        if (arm === 'eager' && label === 'first') {
            for (const tool of listed.tools) {
                if (tool.outputSchema !== undefined) counting.getValidator(tool.outputSchema);
            }
        }
        try {
            const result = await client.callTool({ name: 'binary_session', arguments: catalog.input });
            return {
                label,
                ok: true,
                callMs: performance.now() - started,
                preparations: counting.preparations - preparationsBefore,
                ajvCompiles: engine.compiles - compilesBefore,
                outputSha256: sha256(result.structuredContent),
                text: result.content?.[0]?.text ?? null
            };
        } catch (error) {
            return {
                label,
                ok: false,
                callMs: performance.now() - started,
                preparations: counting.preparations - preparationsBefore,
                ajvCompiles: engine.compiles - compilesBefore,
                errorMessage: String(error?.message ?? error)
            };
        }
    }

    const calls = [await oneCall('first')];
    boundaries.push(sample('after-first-call'));
    if (mode === 'schema') {
        const waitStarted = performance.now();
        while (changed === undefined) {
            if (performance.now() - waitStarted > 5000) throw new Error('list_changed refresh did not arrive');
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        calls.push(await oneCall('previous-body'));
        calls.push(await oneCall('recovery'));
    }
    if (mode === 'malformed') calls.push(await oneCall('recovery'));
    const pid = transport.pid;
    await client.close();
    await transport.close();
    const serverAliveAfterClose = pid !== null && existsSync(`/proc/${pid}`);
    boundaries.push(sample('after-close'));
    const report = {
        arm,
        mode,
        executable: process.execPath,
        node: process.version,
        pid: process.pid,
        serverPid: pid,
        serverAliveAfterClose,
        toolCount: listed.tools.length,
        setupMs,
        listChanged: changed ?? null,
        calls,
        boundaries,
        stderr: stderr.trim(),
        measurement:
            'callMs is performance.now around the eager precompile (first call only) plus client.callTool. preparations count getValidator. ajvCompiles count compile on the injected standard Ajv2020 engine. RSS and heap are sampled only at the named boundaries.'
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (serverAliveAfterClose) process.exitCode = 2;
}

function spawnTrial(arm, mode) {
    const taskset = existsSync('/usr/bin/taskset');
    const nodeArgs = [fileURLToPath(import.meta.url), 'trial', arm, mode];
    const command = taskset ? '/usr/bin/taskset' : process.execPath;
    const args = taskset ? ['-c', '0,1', process.execPath, ...nodeArgs] : nodeArgs;
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: packageRoot,
            env: {
                ...process.env,
                NODE_OPTIONS: '--max-old-space-size=768',
                ARM: arm,
                MODE: mode
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', chunk => {
            stderr += chunk.toString();
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
        }, 90_000);
        child.once('close', code => {
            clearTimeout(timer);
            const alive = existsSync(`/proc/${child.pid}`);
            const line = stdout.trim().split('\n').filter(Boolean).at(-1);
            if (line === undefined) {
                reject(new Error(`trial ${arm}/${mode} produced no JSON (exit ${code}): ${stderr.slice(0, 500)}`));
                return;
            }
            const report = JSON.parse(line);
            report.exitCode = code;
            report.parentSeesAlive = alive;
            resolve(report);
        });
    });
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function leftoverChildren() {
    const listing = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    return listing
        .split('\n')
        .filter(line => line.includes('catalog-session.mjs') || line.includes('production-catalog-cold-bench.mjs trial'));
}

async function main() {
    if (process.argv[2] === 'trial') {
        await runTrial(process.argv[3], process.argv[4]);
        return;
    }
    const catalog = loadProductionCatalog();
    const failures = [];
    const pairs = [];
    for (let index = 0; index < PAIRS.length; index += 1) {
        const order = PAIRS[index];
        const reports = [];
        for (const arm of order) {
            const report = await spawnTrial(arm, 'call');
            reports.push(report);
            if (report.exitCode !== 0 || report.serverAliveAfterClose || report.parentSeesAlive) {
                failures.push(`pair ${index + 1} ${arm} exit ${report.exitCode} alive ${report.serverAliveAfterClose}`);
            }
            if (report.toolCount !== 170) failures.push(`pair ${index + 1} ${arm} listed ${report.toolCount}`);
            const call = report.calls[0];
            if (!call.ok) failures.push(`pair ${index + 1} ${arm} call failed ${call.errorMessage}`);
            if (call.outputSha256 !== catalog.identity.structuredContentSha256) failures.push(`pair ${index + 1} ${arm} body`);
            if (arm === 'candidate' && (call.preparations !== 1 || call.ajvCompiles !== 1)) {
                failures.push(`pair ${index + 1} candidate preparations ${call.preparations} ajv ${call.ajvCompiles}`);
            }
            if (arm === 'eager' && (call.preparations !== 171 || call.ajvCompiles !== 148)) {
                failures.push(`pair ${index + 1} eager preparations ${call.preparations} ajv ${call.ajvCompiles}`);
            }
        }
        const byArm = Object.fromEntries(reports.map(report => [report.arm, report]));
        const difference = byArm.eager.calls[0].callMs - byArm.candidate.calls[0].callMs;
        pairs.push({
            pair: index + 1,
            order,
            eagerMs: byArm.eager.calls[0].callMs,
            candidateMs: byArm.candidate.calls[0].callMs,
            differenceMs: difference,
            eager: byArm.eager,
            candidate: byArm.candidate
        });
    }

    const malformed = await spawnTrial('candidate', 'malformed');
    const schema = await spawnTrial('candidate', 'schema');
    if (malformed.calls[0]?.ok !== false || !String(malformed.calls[0]?.errorMessage).includes('does not match')) {
        failures.push(`malformed first call ${malformed.calls[0]?.errorMessage}`);
    }
    if (malformed.calls[1]?.ok !== true || malformed.calls[1]?.preparations !== 0 || malformed.calls[1]?.ajvCompiles !== 0) {
        failures.push('malformed recovery did not reuse the validator');
    }
    if (malformed.calls[1]?.outputSha256 !== catalog.identity.structuredContentSha256) failures.push('malformed recovery body');
    if (schema.listChanged?.error !== null || schema.listChanged?.count !== 170) failures.push('schema list_changed');
    if (schema.calls[1]?.ok !== false) failures.push('schema previous body was accepted');
    if (schema.calls[2]?.ok !== true) failures.push(`schema recovery failed ${schema.calls[2]?.errorMessage}`);
    if (schema.calls[2]?.outputSha256 !== sha256(recoveryOutput)) failures.push('schema recovery body');
    if (schema.calls[0]?.preparations !== 1 || schema.calls[1]?.preparations !== 1 || schema.calls[2]?.preparations !== 0) {
        failures.push(`schema preparations ${schema.calls.map(call => call.preparations).join(',')}`);
    }
    if (malformed.serverAliveAfterClose || schema.serverAliveAfterClose || malformed.parentSeesAlive || schema.parentSeesAlive) {
        failures.push('negative child still alive');
    }
    const leftovers = leftoverChildren();
    if (leftovers.length > 0) failures.push(`leftover children ${leftovers.join(' | ')}`);

    const head = git(['rev-parse', 'HEAD']);
    const parent = '1fce22a12ab91fb890aa7255f5448e1e1ff0b4a1';
    const sourceDiff = git(['diff', '--name-only', parent, '--', 'packages/client/src', 'packages/core-internal/src']);
    const receipt = {
        label: 'optional cold-process benchmark, this machine only',
        node: process.version,
        executable: process.execPath,
        cpus: cpus().length,
        availableParallelism: availableParallelism(),
        pinnedCpus: existsSync('/usr/bin/taskset') ? '0,1' : null,
        heapMiB: 768,
        parent,
        head,
        lazySourceUnchanged: sourceDiff === '',
        sourceDiff: sourceDiff === '' ? [] : sourceDiff.split('\n'),
        eagerControl:
            'The eager arm precompiles all 170 output schemas on the injected standard Ajv2020 engine, then callTool resolves the same schema from that engine. 171 preparations and 148 Ajv compiles are that control. It is not published client 2.3.1.',
        pairs: pairs.map(pair => ({
            pair: pair.pair,
            order: pair.order,
            eagerMs: pair.eagerMs,
            candidateMs: pair.candidateMs,
            differenceMs: pair.differenceMs,
            eagerPreparations: pair.eager.calls[0].preparations,
            eagerAjvCompiles: pair.eager.calls[0].ajvCompiles,
            candidatePreparations: pair.candidate.calls[0].preparations,
            candidateAjvCompiles: pair.candidate.calls[0].ajvCompiles,
            outputEqual: pair.eager.calls[0].outputSha256 === pair.candidate.calls[0].outputSha256
        })),
        medianDifferenceMs: median(pairs.map(pair => pair.differenceMs)),
        malformed,
        schema,
        leftovers,
        failures,
        boundariesNote: 'RSS and heap samples stay on the trial reports. They are not a retained-memory conclusion.'
    };
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (process.env.PRODUCTION_CATALOG_BENCH_RECEIPT !== undefined) {
        writeFileSync(process.env.PRODUCTION_CATALOG_BENCH_RECEIPT, text);
    }
    process.stdout.write(text);
    if (failures.length > 0) process.exitCode = 1;
}

await main();
