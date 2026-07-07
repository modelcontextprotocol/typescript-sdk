import { describe, expect, it, vi } from 'vitest';

import * as barrel from '../../src/index';

/**
 * Enforces the cross-bundle branding participation criterion from
 * `core-internal/src/errors/crossBundleBrand.ts`: every error class exported
 * from this package's public surface must carry an own `mcpBrand` static and
 * resolve `instanceof` through a branded `Symbol.hasInstance`.
 *
 * This is the infrastructure that replaces "remember the static block": adding
 * a new exported error class without branding turns this test red naming the
 * class, instead of shipping a subclass whose cross-bundle `instanceof`
 * silently returns false while its parent still matches.
 */

/** Error classes exported on purpose without a brand. Justify every entry. */
const UNBRANDED_ALLOWLIST: ReadonlySet<string> = new Set();

function exportedErrorClasses(mod: Record<string, unknown>): Array<[string, Function]> {
    return Object.entries(mod)
        .filter((entry): entry is [string, Function] => {
            const v = entry[1];
            return typeof v === 'function' && v !== Error && v.prototype instanceof Error;
        })
        .sort(([a], [b]) => a.localeCompare(b));
}

describe('error brand conformance (client export surface)', () => {
    const classes = exportedErrorClasses(barrel as Record<string, unknown>);

    it('finds the export surface (guards against a broken walker)', () => {
        expect(classes.length).toBeGreaterThanOrEqual(15);
        expect(classes.map(([n]) => n)).toContain('ProtocolError');
        expect(classes.map(([n]) => n)).toContain('OAuthClientFlowError');
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

    // Core-internal brand strings are pinned once, in core-internal's
    // errorSurfacePins.test.ts — this test only asserts the core re-export SET
    // so a rename there is not double-maintained here.
    const CORE_PINNED = new Set([
        'DiscoveryUrlBlockedError',
        'MissingRequiredClientCapabilityError',
        'OAuthError',
        'ProtocolError',
        'ResourceNotFoundError',
        'SdkError',
        'SdkHttpError',
        'UnsupportedProtocolVersionError',
        'UrlElicitationRequiredError'
    ]);

    it('pins every client-local brand string (renaming one severs cross-version matching — must be deliberate)', () => {
        const brands = Object.fromEntries(
            classes
                .filter(([name, cls]) => !CORE_PINNED.has(name) && Object.prototype.hasOwnProperty.call(cls, 'mcpBrand'))
                .map(([name, cls]) => [name, (cls as never as { mcpBrand: string }).mcpBrand])
        );
        expect(brands).toEqual({
            AuthorizationServerMismatchError: 'mcp.AuthorizationServerMismatchError',
            InsecureTokenEndpointError: 'mcp.InsecureTokenEndpointError',
            InsufficientScopeError: 'mcp.InsufficientScopeError',
            IssuerMismatchError: 'mcp.IssuerMismatchError',
            OAuthClientFlowError: 'mcp.OAuthClientFlowError',
            RedirectFilteredResponseError: 'mcp.RedirectFilteredResponseError',
            RegistrationRejectedError: 'mcp.RegistrationRejectedError',
            SseError: 'mcp.SseError',
            UnauthorizedError: 'mcp.UnauthorizedError'
        });
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

    it('core re-exported error classes are exactly the set pinned in errorSurfacePins.test.ts', () => {
        const coreExported = classes.map(([name]) => name).filter(name => CORE_PINNED.has(name));
        expect(coreExported).toEqual([...CORE_PINNED].sort((a, b) => a.localeCompare(b)));
    });

    it('the OAuth flow family and UnauthorizedError match across module copies', async () => {
        vi.resetModules();
        const foreignAuthErrors = await import('../../src/client/authErrors');
        const foreignAuth = await import('../../src/client/auth');
        // Guard the premise: a cached module would make every check below pass
        // trivially through prototype identity.
        expect(foreignAuthErrors.IssuerMismatchError).not.toBe(barrel.IssuerMismatchError);
        expect(foreignAuth.UnauthorizedError).not.toBe(barrel.UnauthorizedError);

        const issuer = new foreignAuthErrors.IssuerMismatchError('metadata', 'a', 'b');
        expect(issuer instanceof barrel.IssuerMismatchError).toBe(true);
        expect(issuer instanceof barrel.OAuthClientFlowError).toBe(true);
        expect(issuer instanceof barrel.UnauthorizedError).toBe(false);

        const unauthorized = new foreignAuth.UnauthorizedError('nope');
        expect(unauthorized instanceof barrel.UnauthorizedError).toBe(true);
        expect(unauthorized.name).toBe('UnauthorizedError');

        // the isInstance guards read the same brands: cross-copy agreement
        expect(barrel.IssuerMismatchError.isInstance(issuer)).toBe(true);
        expect(barrel.OAuthClientFlowError.isInstance(issuer)).toBe(true);
        expect(barrel.UnauthorizedError.isInstance(issuer)).toBe(false);
        expect(barrel.UnauthorizedError.isInstance(unauthorized)).toBe(true);
    });
});
