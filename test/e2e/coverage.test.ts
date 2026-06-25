/**
 * Manifest gates for the e2e suite.
 *
 * The linkage is inverted: test files cite the requirement id(s) they prove via
 * `verifies(...)` (helpers/verifies.ts) and requirements.ts is pure data. These
 * tests statically scan test/e2e/scenarios/*.test.ts for the cited ids and check them
 * against the manifest, plus the manifest's own internal consistency rules.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { REQUIREMENTS } from './requirements';

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));

interface VerifiesCall {
    file: string;
    /** Explicit `{ title: '...' }` passed to verifies(), if any (undefined for an untitled body). */
    title: string | undefined;
    ids: string[];
}

/** Statically scan test/e2e/scenarios/*.test.ts for `verifies(<ids>, ...)` calls. */
function scanVerifiesCalls(): VerifiesCall[] {
    const calls: VerifiesCall[] = [];
    const scenariosDir = path.join(E2E_DIR, 'scenarios');
    const files = readdirSync(scenariosDir)
        .filter(f => f.endsWith('.test.ts'))
        .toSorted();
    for (const file of files) {
        const text = readFileSync(path.join(scenariosDir, file), 'utf8');
        // Each call spans from its header to the first column-0 close (`});` for an
        // untitled hugged call, `);` for a call expanded by an opts third argument).
        for (const m of text.matchAll(/verifies\(\s*('[^']*'|\[[^\]]*\])\s*,\s*async\s*\([\s\S]*?\n(?:\}\);|\);)/g)) {
            const ids = [...(m[1] ?? '').matchAll(/'([^']*)'/g)].map(x => x[1]).filter(id => id !== undefined);
            const title = m[0].match(/\{\s*title:\s*'([^']*)'\s*\}\s*\n?\);$/)?.[1];
            calls.push({ file, title, ids });
        }
    }
    return calls;
}

const CALLS = scanVerifiesCalls();
const CITED = new Set(CALLS.flatMap(c => c.ids));

test('every non-deferred requirement id is cited by at least one verifies() call', () => {
    const missing = Object.entries(REQUIREMENTS)
        .filter(([id, r]) => !r.deferred && !CITED.has(id))
        .map(([id]) => id);
    expect(missing).toEqual([]);
});

test('every cited requirement id exists in the manifest and is not deferred', () => {
    const bad: string[] = [];
    for (const c of CALLS) {
        for (const id of c.ids) {
            const req = REQUIREMENTS[id];
            if (!req) bad.push(`${c.file}: a verifies() call cites unknown requirement '${id}'`);
            else if (req.deferred) bad.push(`${c.file}: a verifies() call cites deferred requirement '${id}'`);
        }
    }
    expect(bad).toEqual([]);
});

test('every knownFailure with a test string names an explicit verifies() title that cites the requirement', () => {
    const bad: string[] = [];
    for (const [id, r] of Object.entries(REQUIREMENTS)) {
        for (const kf of r.knownFailures ?? []) {
            if (kf.test === undefined) continue;
            const cited = CALLS.some(c => c.title === kf.test && c.ids.includes(id));
            if (!cited)
                bad.push(
                    `${id}: knownFailure references title '${kf.test}', which is not an explicit verifies() title citing this requirement`
                );
        }
    }
    expect(bad).toEqual([]);
});

test('every transport-restricted requirement explains why in note', () => {
    const missing = Object.entries(REQUIREMENTS)
        .filter(([, r]) => r.transports !== undefined && !r.note)
        .map(([id]) => id);
    expect(missing).toEqual([]);
});

test('supersedes/supersededBy links are symmetric and resolve', () => {
    const bad: string[] = [];
    for (const [id, req] of Object.entries(REQUIREMENTS)) {
        for (const oldId of req.supersedes ?? []) {
            const old = REQUIREMENTS[oldId];
            if (!old) bad.push(`${id}: supersedes unknown id '${oldId}'`);
            else if (old.supersededBy !== id)
                bad.push(`${id}: supersedes '${oldId}', but that entry's supersededBy is '${old.supersededBy}'`);
        }
        if (req.supersededBy !== undefined) {
            const successor = REQUIREMENTS[req.supersededBy];
            if (!successor) bad.push(`${id}: supersededBy unknown id '${req.supersededBy}'`);
            else if (!successor.supersedes?.includes(id))
                bad.push(`${id}: supersededBy '${req.supersededBy}', but that entry's supersedes array does not include '${id}'`);
            if (req.removedInSpecVersion === undefined)
                bad.push(`${id}: has supersededBy but no removedInSpecVersion (only a retired entry can be superseded)`);
        }
        if (req.supersedes !== undefined && req.addedInSpecVersion === undefined)
            bad.push(`${id}: has supersedes but no addedInSpecVersion (a superseding entry is by definition new)`);
    }
    expect(bad).toEqual([]);
});
