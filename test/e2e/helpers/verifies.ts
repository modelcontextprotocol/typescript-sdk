/**
 * Inverted manifest linkage: tests declare which requirement(s) they satisfy.
 * (Staged here in the harness; the restructure codemod copies this file to
 * sdk/test/e2e/helpers/verifies.ts when the inversion is executed.)
 *
 * `verifies(id, fn, opts?)` looks the requirement up in the pure-data manifest
 * and registers one cell per applicable (transport, spec version) — the same
 * names and semantics the old matrix runner produced — applying `test.fails`
 * for knownFailures and the global 15s timeout. Unknown or deferred ids throw
 * at registration time, so a typo can never silently drop coverage.
 *
 * Bodies are anonymous; the registered test title is `opts?.title ?? 'verifies'`.
 * An explicit `opts.title` is only needed when a requirement is cited by more
 * than one body (to tell them apart) — a knownFailure with a `test` string only
 * applies to the body registered with that exact title.
 */

import { describe, test } from 'vitest';

import { REQUIREMENTS } from '../requirements.js';
import { ALL_SPEC_VERSIONS, ALL_TRANSPORTS, type TestArgs } from '../types.js';

type TestBody = (args: TestArgs) => Promise<void>;

export function verifies(id: string | readonly string[], fn: TestBody, opts?: { title?: string }): void {
    const ids = Array.isArray(id) ? id : [id];
    for (const rid of ids) registerOne(rid, fn, opts);
}

function registerOne(id: string, fn: TestBody, opts?: { title?: string }): void {
    const req = REQUIREMENTS[id];
    if (!req) throw new Error(`verifies('${id}'): unknown requirement id`);
    if (req.deferred) throw new Error(`verifies('${id}'): requirement is deferred — drop the deferral or the test`);

    const transports = req.transports ?? ALL_TRANSPORTS;
    const versions = ALL_SPEC_VERSIONS.filter(
        v =>
            (req.addedInSpecVersion === undefined || v >= req.addedInSpecVersion) &&
            (req.removedInSpecVersion === undefined || v < req.removedInSpecVersion)
    );
    const cells = versions.flatMap(v => transports.map(t => [t, v] as const));

    describe.each(cells)(`${id} [%s %s]`, (transport, protocolVersion) => {
        const kf = req.knownFailures?.find(
            k =>
                (k.test === undefined || k.test === opts?.title) &&
                (k.transport === undefined || k.transport === transport) &&
                (k.specVersion === undefined || k.specVersion === protocolVersion)
        );
        const run = kf ? test.fails : test;
        run(opts?.title ?? 'verifies', () => fn({ transport, protocolVersion }), 15_000);
    });
}
