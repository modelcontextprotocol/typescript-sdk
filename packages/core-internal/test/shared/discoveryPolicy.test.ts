import {
    assertAllowedDiscoveryUrl,
    DiscoveryUrlBlockedError,
    type DiscoveryUrlContext,
    type DiscoveryUrlPolicyOptions,
    type DiscoveryUrlPurpose
} from '../../src/shared/discoveryPolicy';

const ALL_PURPOSES: DiscoveryUrlPurpose[] = [
    'resource-metadata',
    'authorization-server',
    'as-metadata',
    'authorization-endpoint',
    'token-endpoint',
    'registration-endpoint',
    'redirect-hop'
];

const REMOTE_SERVER = new URL('https://mcp.example.com/mcp');
const LOOPBACK_SERVER = new URL('http://localhost:3000/mcp');

const REMOTE_PRODUCER = { url: REMOTE_SERVER, kind: 'mcp-server' } as const;
const LOOPBACK_PRODUCER = { url: LOOPBACK_SERVER, kind: 'mcp-server' } as const;

function ctx(url: string, overrides: Partial<DiscoveryUrlContext> = {}): DiscoveryUrlContext {
    return {
        purpose: 'as-metadata',
        url: new URL(url),
        producer: REMOTE_PRODUCER,
        source: 'sdk-derived',
        ...overrides
    };
}

function check(url: string, overrides: Partial<DiscoveryUrlContext> = {}, opts?: DiscoveryUrlPolicyOptions): void {
    assertAllowedDiscoveryUrl(ctx(url, overrides), opts);
}

describe('assertAllowedDiscoveryUrl', () => {
    describe('purpose coverage', () => {
        it.each(ALL_PURPOSES)('allows a conformant https URL for purpose %s', purpose => {
            // resource-metadata must be same-origin with the server (RFC 9728 §3);
            // every other purpose may name a different https origin.
            const url =
                purpose === 'resource-metadata'
                    ? 'https://mcp.example.com/.well-known/oauth-protected-resource'
                    : 'https://as.example.com/.well-known/oauth-authorization-server';
            expect(() => check(url, { purpose })).not.toThrow();
        });

        it.each(ALL_PURPOSES)('denies a non-loopback http URL for purpose %s', purpose => {
            const url =
                purpose === 'resource-metadata'
                    ? 'http://mcp.example.com/.well-known/oauth-protected-resource'
                    : 'http://as.example.com/authorize';
            expect(() => check(url, { purpose })).toThrow(DiscoveryUrlBlockedError);
        });
    });

    describe('scheme rule (https-or-loopback)', () => {
        it('allows https URLs on public hosts', () => {
            expect(() => check('https://as.example.com/token')).not.toThrow();
        });

        it('denies http URLs on public hosts (fail closed)', () => {
            expect(() => check('http://as.example.com/token')).toThrow(DiscoveryUrlBlockedError);
        });

        it('allows http URLs on loopback hosts when the server is also local (RFC 8252 §7.3)', () => {
            expect(() => check('http://localhost:9000/token', { producer: LOOPBACK_PRODUCER })).not.toThrow();
            expect(() => check('http://127.0.0.1:9000/token', { producer: LOOPBACK_PRODUCER })).not.toThrow();
            expect(() => check('http://[::1]:9000/token', { producer: LOOPBACK_PRODUCER })).not.toThrow();
        });

        it('denies non-http(s) schemes regardless of options', () => {
            const allOn: DiscoveryUrlPolicyOptions = {
                allowHttpDiscovery: true,
                allowCrossOriginResourceMetadata: true,
                allowPrivateAddressTargets: true
            };
            expect(() => check('ftp://as.example.com/metadata', {}, allOn)).toThrow(DiscoveryUrlBlockedError);
        });

        it('denies URLs carrying userinfo credentials', () => {
            expect(() => check('https://user:secret@as.example.com/token')).toThrow(DiscoveryUrlBlockedError);
            expect(() => check('https://user@as.example.com/token')).toThrow(DiscoveryUrlBlockedError);
        });

        it('allowHttpDiscovery permits non-loopback http', () => {
            expect(() => check('http://as.example.com/token', {}, { allowHttpDiscovery: true })).not.toThrow();
        });
    });

    describe('locality symmetry rule', () => {
        describe('loopback targets with a remote server are denied (each family and canonical form)', () => {
            it.each([
                ['https://127.0.0.1/token', '127.0.0.1'],
                ['https://127.8.8.8/token', '127/8 literal'],
                ['https://[::1]/token', 'IPv6 loopback'],
                ['https://localhost/token', 'loopback hostname'],
                ['https://2130706433/token', 'decimal form of 127.0.0.1'],
                ['https://0x7f000001/token', 'hex form of 127.0.0.1'],
                ['https://0177.0.0.1/token', 'octal form of 127.0.0.1'],
                ['https://[::ffff:127.0.0.1]/token', 'IPv4-mapped loopback']
            ])('denies %s (%s)', url => {
                // The WHATWG URL parser canonicalizes every encoded form before
                // the hostname reaches the policy.
                expect(() => check(url)).toThrow(DiscoveryUrlBlockedError);
            });
        });

        it('allows loopback targets when the server itself is loopback', () => {
            expect(() => check('https://127.0.0.1/token', { producer: LOOPBACK_PRODUCER })).not.toThrow();
            expect(() => check('http://localhost:9000/token', { producer: LOOPBACK_PRODUCER })).not.toThrow();
            expect(() => check('https://[::1]/token', { producer: LOOPBACK_PRODUCER })).not.toThrow();
        });

        it('allows loopback targets when the server is a private-range literal', () => {
            expect(() =>
                check('https://127.0.0.1/token', { producer: { url: new URL('https://10.1.2.3/mcp'), kind: 'mcp-server' } })
            ).not.toThrow();
        });

        describe('private-range literals with a remote server are denied', () => {
            it.each([
                ['https://10.0.0.1/token', '10/8'],
                ['https://172.16.0.1/token', '172.16/12 lower bound'],
                ['https://172.31.255.255/token', '172.16/12 upper bound'],
                ['https://192.168.1.1/token', '192.168/16'],
                ['https://169.254.169.254/token', '169.254/16 link-local'],
                ['https://0.0.0.0/token', 'unspecified IPv4'],
                ['https://[::]/token', 'unspecified IPv6'],
                ['https://[fc00::1]/token', 'unique-local fc00::/7'],
                ['https://[fdab::1]/token', 'unique-local fd00 range'],
                ['https://[fe80::1]/token', 'link-local fe80::/10'],
                ['https://[::ffff:10.0.0.1]/token', 'IPv4-mapped private']
            ])('denies %s (%s)', url => {
                expect(() => check(url)).toThrow(DiscoveryUrlBlockedError);
            });
        });

        it.each([
            ['https://172.32.0.1/token', 'just above 172.16/12'],
            ['https://172.15.255.255/token', 'just below 172.16/12'],
            ['https://11.0.0.1/token', 'outside 10/8'],
            ['https://[fe00::1]/token', 'outside fc00::/7 and fe80::/10'],
            ['https://[2001:db8::1]/token', 'global IPv6']
        ])('allows the public literal %s (%s)', url => {
            expect(() => check(url)).not.toThrow();
        });

        it('never blocks DNS names by locality (no name resolution is performed)', () => {
            // An authorization server on a private https DNS name stays deployable
            // by default; the policy classifies IP literals only.
            expect(() => check('https://idp.corp.internal/.well-known/oauth-authorization-server')).not.toThrow();
            expect(() => check('https://intranet.example/token')).not.toThrow();
        });

        it('allowPrivateAddressTargets disables the rule', () => {
            expect(() => check('https://10.0.0.1/token', {}, { allowPrivateAddressTargets: true })).not.toThrow();
            expect(() => check('https://[fe80::1]/token', {}, { allowPrivateAddressTargets: true })).not.toThrow();
        });

        it('anchors on the producing step and names its kind in the rejection', () => {
            expect(() =>
                check('https://10.0.0.1/token', {
                    purpose: 'token-endpoint',
                    source: 'authorization-server-metadata',
                    producer: { url: new URL('https://as.example.com'), kind: 'authorization-server' }
                })
            ).toThrow(/authorization server 'as\.example\.com'/);
            expect(() => check('https://10.0.0.1/token')).toThrow(/MCP server 'mcp\.example\.com'/);
        });

        it('allows a loopback endpoint published by a loopback authorization server', () => {
            expect(() =>
                check('http://127.0.0.1:9000/token', {
                    purpose: 'token-endpoint',
                    source: 'authorization-server-metadata',
                    producer: { url: new URL('http://localhost:9000'), kind: 'authorization-server' }
                })
            ).not.toThrow();
        });
    });

    describe('resource-metadata origin rule', () => {
        const prm = (url: string): DiscoveryUrlContext => ctx(url, { purpose: 'resource-metadata', source: 'www-authenticate' });

        it('allows same-origin protected-resource-metadata URLs', () => {
            expect(() => assertAllowedDiscoveryUrl(prm('https://mcp.example.com/.well-known/oauth-protected-resource/mcp'))).not.toThrow();
        });

        it('denies cross-origin protected-resource-metadata URLs (host, scheme, or port mismatch)', () => {
            expect(() => assertAllowedDiscoveryUrl(prm('https://other.example.com/.well-known/oauth-protected-resource'))).toThrow(
                DiscoveryUrlBlockedError
            );
            expect(() => assertAllowedDiscoveryUrl(prm('https://mcp.example.com:8443/.well-known/oauth-protected-resource'))).toThrow(
                DiscoveryUrlBlockedError
            );
        });

        it('allowCrossOriginResourceMetadata disables the rule', () => {
            expect(() =>
                assertAllowedDiscoveryUrl(prm('https://other.example.com/.well-known/oauth-protected-resource'), {
                    allowCrossOriginResourceMetadata: true
                })
            ).not.toThrow();
        });

        it('does not impose the origin rule on other purposes', () => {
            expect(() => check('https://as.example.com/.well-known/oauth-authorization-server', { purpose: 'as-metadata' })).not.toThrow();
        });
    });

    describe('authorization-server issuer syntax rule (RFC 8414 §2)', () => {
        const issuer = (url: string): DiscoveryUrlContext =>
            ctx(url, { purpose: 'authorization-server', source: 'protected-resource-metadata' });

        it('allows issuer identifiers with a path component', () => {
            expect(() => assertAllowedDiscoveryUrl(issuer('https://as.example.com/tenant1'))).not.toThrow();
        });

        it('denies issuer identifiers with a query component', () => {
            expect(() => assertAllowedDiscoveryUrl(issuer('https://as.example.com/?tenant=1'))).toThrow(DiscoveryUrlBlockedError);
        });

        it('denies issuer identifiers with a fragment component', () => {
            expect(() => assertAllowedDiscoveryUrl(issuer('https://as.example.com/#section'))).toThrow(DiscoveryUrlBlockedError);
        });

        it('does not impose issuer syntax on other purposes', () => {
            expect(() =>
                check('https://as.example.com/.well-known/oauth-authorization-server?x=1', { purpose: 'as-metadata' })
            ).not.toThrow();
        });
    });

    describe('DiscoveryUrlBlockedError', () => {
        it('carries the full context and a reason naming the overriding option', () => {
            const context = ctx('https://10.0.0.1/token', { purpose: 'token-endpoint', source: 'authorization-server-metadata' });
            let caught: unknown;
            try {
                assertAllowedDiscoveryUrl(context);
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(DiscoveryUrlBlockedError);
            const blocked = caught as DiscoveryUrlBlockedError;
            expect(blocked.name).toBe('DiscoveryUrlBlockedError');
            expect(blocked.context).toBe(context);
            expect(blocked.context.purpose).toBe('token-endpoint');
            expect(blocked.context.source).toBe('authorization-server-metadata');
            expect(blocked.context.url.href).toBe('https://10.0.0.1/token');
            expect(blocked.context.producer).toBe(REMOTE_PRODUCER);
            expect(blocked.reason).toContain('allowPrivateAddressTargets');
            expect(blocked.message).toContain('https://10.0.0.1/token');
            expect(blocked.message).toContain('token-endpoint');
        });

        it('names allowHttpDiscovery on scheme rejections and allowCrossOriginResourceMetadata on origin rejections', () => {
            expect(() => check('http://as.example.com/token')).toThrow(/allowHttpDiscovery/);
            expect(() =>
                check('https://other.example.com/.well-known/oauth-protected-resource', {
                    purpose: 'resource-metadata',
                    source: 'caller'
                })
            ).toThrow(/allowCrossOriginResourceMetadata/);
        });

        it('carries the redirect hop when validating a Location target', () => {
            const context = ctx('https://192.168.1.1/hop', {
                purpose: 'redirect-hop',
                redirectHop: {
                    from: new URL('https://as.example.com/.well-known/oauth-authorization-server'),
                    status: 302,
                    originalPurpose: 'as-metadata'
                }
            });
            let caught: unknown;
            try {
                assertAllowedDiscoveryUrl(context);
            } catch (error) {
                caught = error;
            }
            expect(caught).toBeInstanceOf(DiscoveryUrlBlockedError);
            expect((caught as DiscoveryUrlBlockedError).context.redirectHop?.originalPurpose).toBe('as-metadata');
            expect((caught as DiscoveryUrlBlockedError).context.redirectHop?.status).toBe(302);
        });
    });
});
