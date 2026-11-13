import { describe, expect, it, vi } from 'vitest';

import * as skills from '../../src/ext/skills/index';
import * as skillsNode from '../../src/ext/skills/node';
import * as barrel from '../../src/index';

/** Every public entry that can export an error class: the root and the skills extension's subpaths. */
const SURFACES: ReadonlyArray<Record<string, unknown>> = [barrel, skills, skillsNode];

/**
 * Server-side twin of the client's errorBrandConformance test: every error
 * class exported from this package's public surface must carry an own
 * `mcpBrand` static and resolve `instanceof` through a branded
 * `Symbol.hasInstance`, so a new exported error class cannot silently regress
 * to prototype-identity `instanceof` across bundled copies. See
 * `core-internal/src/errors/crossBundleBrand.ts` for the participation
 * criterion.
 */

/** Error classes exported on purpose without a brand. Justify every entry. */
const UNBRANDED_ALLOWLIST: ReadonlySet<string> = new Set([]);

function exportedErrorClasses(surfaces: ReadonlyArray<Record<string, unknown>>): Array<[string, Function]> {
    const found = new Map<string, Function>();
    for (const surface of surfaces) {
        for (const [name, v] of Object.entries(surface)) {
            if (typeof v !== 'function' || v === Error || !(v.prototype instanceof Error)) continue;
            if (found.has(name) && found.get(name) !== v) throw new Error(`two entries export different error classes named ${name}`);
            found.set(name, v);
        }
    }
    return [...found].sort(([a], [b]) => a.localeCompare(b));
}

describe('error brand conformance (server export surface)', () => {
    const classes = exportedErrorClasses(SURFACES);

    it('finds the export surface (guards against a broken walker)', () => {
        expect(classes.length).toBeGreaterThanOrEqual(5);
        expect(classes.map(([n]) => n)).toContain('ProtocolError');
        expect(classes.map(([n]) => n)).toContain('SkillCatalogError');
    });

    it('every exported error class is branded (or explicitly allowlisted)', () => {
        const unbranded = classes
            .filter(([name]) => !UNBRANDED_ALLOWLIST.has(name))
            .filter(([, cls]) => !Object.prototype.hasOwnProperty.call(cls, 'mcpBrand'))
            .map(([name]) => name);
        expect(
            unbranded,
            `unbranded exported error classes (add the static mcpBrand block, or allowlist with a justification): ${unbranded.join(', ')}`
        ).toEqual([]);
    });

    it('every branded class resolves instanceof through a branded hasInstance', () => {
        const missing = classes
            .filter(([, cls]) => Object.prototype.hasOwnProperty.call(cls, 'mcpBrand'))
            .filter(([, cls]) => (cls as never as Record<symbol, unknown>)[Symbol.hasInstance] === Function.prototype[Symbol.hasInstance])
            .map(([name]) => name);
        expect(missing, `branded classes whose hierarchy root does not install brandedHasInstance: ${missing.join(', ')}`).toEqual([]);
    });

    it('every branded class exposes an isInstance guard that agrees with instanceof', () => {
        const branded = classes.filter(([, cls]) => Object.prototype.hasOwnProperty.call(cls, 'mcpBrand'));
        const missing = branded.filter(([, cls]) => typeof (cls as { isInstance?: unknown }).isInstance !== 'function').map(([n]) => n);
        expect(missing, `branded classes without a static isInstance guard: ${missing.join(', ')}`).toEqual([]);
        for (const [, cls] of branded) {
            const guard = (cls as unknown as { isInstance: (v: unknown) => boolean }).isInstance;
            for (const v of [new Error('plain'), null, undefined, 0, '', {}]) {
                expect(guard.call(cls, v)).toBe(v instanceof (cls as never as new () => unknown));
            }
        }
    });

    // Core-internal brand strings are pinned in core-internal's
    // errorSurfacePins.test.ts. A server-local branded error class must add its
    // brand string here so a rename cannot land silently.
    const CORE_PINNED = new Set([
        'MissingRequiredClientCapabilityError',
        'OAuthError',
        'ProtocolError',
        'ResourceNotFoundError',
        'SdkError',
        'SdkHttpError',
        'UnsupportedProtocolVersionError',
        'UrlElicitationRequiredError'
    ]);
    const SERVER_LOCAL_BRANDS: Record<string, string> = { SkillCatalogError: 'mcp.SkillCatalogError' };

    it('pins every server-local brand string (add new entries here — renames must be deliberate)', () => {
        const brands = Object.fromEntries(
            classes
                .filter(([name, cls]) => !CORE_PINNED.has(name) && Object.prototype.hasOwnProperty.call(cls, 'mcpBrand'))
                .map(([name, cls]) => [name, (cls as never as { mcpBrand: string }).mcpBrand])
        );
        expect(brands).toEqual(SERVER_LOCAL_BRANDS);
    });

    it('SkillCatalogError matches across module copies', async () => {
        vi.resetModules();
        const foreign = await import('../../src/ext/skills/errors');
        // Guard the premise: a cached module would make the checks pass through prototype identity.
        expect(foreign.SkillCatalogError).not.toBe(skills.SkillCatalogError);
        const error = new foreign.SkillCatalogError([{ path: 'git-workflow/SKILL.md', message: 'invalid' }]);
        expect(error instanceof skills.SkillCatalogError).toBe(true);
        expect(skills.SkillCatalogError.isInstance(error)).toBe(true);
        expect(error.name).toBe('SkillCatalogError');
        expect(new Error('plain') instanceof skills.SkillCatalogError).toBe(false);
    });
});
