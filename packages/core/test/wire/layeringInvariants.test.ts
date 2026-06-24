/**
 * Wire-layer / public-layer import isolation, enforced as a test.
 *
 * eslint.config.mjs carries the matching `@typescript-eslint/no-restricted-imports`
 * rules; this suite re-derives the same invariants directly from source so the
 * lint rules cannot be silently weakened, scoped away, or `eslint-disable`d.
 *
 * Invariants:
 *   (a) No file outside src/wire/ imports from a wire/rev… module. No exceptions.
 *   (b) No file inside a src/wire/rev… directory has a runtime (non-type-only)
 *       import from types/schemas — wire revision schemas are frozen copies.
 *   (c) No `eslint-disable` directive for `no-restricted-imports` appears in
 *       any file covered by (a) or (b).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { posix, sep } from 'node:path';

import { describe, expect, expectTypeOf, test } from 'vitest';

import type { WireCodec } from '../../src/wire/codec.js';

const SRC_ROOT = new URL('../../src/', import.meta.url);

function listSourceFiles(): string[] {
    // Recursive walk of src/ for .ts files (excluding .d.ts). Paths returned
    // posix-normalised relative to src/ so assertions are stable across OSes.
    const out: string[] = [];
    const walk = (rel: string) => {
        for (const entry of readdirSync(new URL(rel, SRC_ROOT), { withFileTypes: true })) {
            const child = rel + entry.name;
            if (entry.isDirectory()) {
                walk(child + '/');
            } else if (entry.isFile() && child.endsWith('.ts') && !child.endsWith('.d.ts')) {
                out.push(child.split(sep).join(posix.sep));
            }
        }
    };
    walk('');
    return out.sort();
}

function read(rel: string): string {
    return readFileSync(new URL(rel, SRC_ROOT), 'utf8');
}

/** Matches any import/re-export whose module specifier contains `wire/rev`. */
const WIRE_REV_IMPORT = /^(import|export)\b[^;]*?\bfrom\s+['"][^'"]*wire\/rev[^'"]*['"]/m;

/** Matches a runtime (non-type-only) import or re-export of the public schemas module. */
const RUNTIME_SCHEMAS_IMPORT = /^(import|export)\s+(?!type\b)[^;]*?\bfrom\s+['"][^'"]*types\/schemas(?:\.js)?['"]/m;

/** Matches an eslint-disable directive that touches a no-restricted-imports rule. */
const DISABLE_RESTRICTED = /eslint-disable[^\n]*no-restricted-imports/;

describe('wire-layer / public-layer import isolation', () => {
    const allFiles = listSourceFiles();
    const outsideWire = allFiles.filter(f => !f.startsWith('wire/'));
    const insideWireRev = allFiles.filter(f => /^wire\/rev[^/]+\//.test(f));

    test('(a) no file outside src/wire/ imports from a wire/rev* module', () => {
        const offenders = outsideWire.filter(f => WIRE_REV_IMPORT.test(read(f)));
        expect(offenders).toEqual([]);
    });

    test('(b) no runtime import of types/schemas inside src/wire/rev*/', () => {
        const offenders = insideWireRev.filter(f => RUNTIME_SCHEMAS_IMPORT.test(read(f)));
        expect(offenders).toEqual([]);
    });

    test('(c) no eslint-disable of no-restricted-imports in covered files', () => {
        const covered = [...outsideWire, ...insideWireRev];
        const offenders = covered.filter(f => DISABLE_RESTRICTED.test(read(f)));
        expect(offenders).toEqual([]);
    });

    test('sanity: walk found both partitions', () => {
        expect(outsideWire.length).toBeGreaterThan(0);
        expect(insideWireRev.length).toBeGreaterThan(0);
    });
});

describe('WireCodec interface is function-only (no schema getters)', () => {
    // The pre-separation interface exposed per-method Zod schema getters
    // (`requestSchema(m)`, `resultSchema(m)`, …). Those were the leak that let
    // callers reach raw validators across the layer boundary. Re-adding ANY of
    // them must fail this suite even if the return type is widened to `unknown`.
    const FORBIDDEN = ['requestSchema', 'resultSchema', 'notificationSchema', 'inputRequestSchema', 'inputResponseSchema'] as const;

    test('(d) type-level: forbidden identifiers are not keys of WireCodec', () => {
        type Forbidden = (typeof FORBIDDEN)[number];
        // If any forbidden name re-enters `keyof WireCodec`, the intersection
        // becomes that literal (≠ never) and this assertion fails to compile.
        expectTypeOf<Extract<keyof WireCodec, Forbidden>>().toEqualTypeOf<never>();
    });

    test('(d) source-level: codec.ts WireCodec body declares no *Schema members', () => {
        const src = readFileSync(new URL('wire/codec.ts', SRC_ROOT), 'utf8');
        const open = src.indexOf('export interface WireCodec');
        expect(open).toBeGreaterThan(-1);
        // Find the matching closing brace of the interface body.
        let depth = 0;
        let close = -1;
        for (let i = src.indexOf('{', open); i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}' && --depth === 0) {
                close = i;
                break;
            }
        }
        expect(close).toBeGreaterThan(open);
        const body = src.slice(open, close);
        for (const name of FORBIDDEN) {
            // Match `name(` or `name:` or `name?` at a member-declaration
            // position (start-of-line modulo whitespace / `readonly`).
            const re = new RegExp(String.raw`^\s*(?:readonly\s+)?${name}\s*[(:?]`, 'm');
            expect(body).not.toMatch(re);
        }
    });
});
