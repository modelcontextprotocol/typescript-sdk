import { describe, expect, it } from 'vitest';

import * as barrel from '../../src/index';

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

function exportedErrorClasses(mod: Record<string, unknown>): Array<[string, Function]> {
    return Object.entries(mod)
        .filter((entry): entry is [string, Function] => {
            const v = entry[1];
            return typeof v === 'function' && v !== Error && v.prototype instanceof Error;
        })
        .sort(([a], [b]) => a.localeCompare(b));
}

describe('error brand conformance (server export surface)', () => {
    const classes = exportedErrorClasses(barrel as Record<string, unknown>);

    it('finds the export surface (guards against a broken walker)', () => {
        expect(classes.length).toBeGreaterThanOrEqual(5);
        expect(classes.map(([n]) => n)).toContain('ProtocolError');
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
    const SERVER_LOCAL_BRANDS: Record<string, string> = {};

    it('pins every server-local brand string (add new entries here — renames must be deliberate)', () => {
        const brands = Object.fromEntries(
            classes
                .filter(([name, cls]) => !CORE_PINNED.has(name) && Object.prototype.hasOwnProperty.call(cls, 'mcpBrand'))
                .map(([name, cls]) => [name, (cls as never as { mcpBrand: string }).mcpBrand])
        );
        expect(brands).toEqual(SERVER_LOCAL_BRANDS);
    });
});
