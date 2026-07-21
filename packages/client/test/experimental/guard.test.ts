import { describe, expect, it } from 'vitest';

import { ServerCardError } from '../../src/experimental/serverCard/errors';
import { assertAllowedUrl } from '../../src/experimental/serverCard/guard';

function codeOf(fn: () => void): string | undefined {
    try {
        fn();
        return undefined;
    } catch (error) {
        expect(error).toBeInstanceOf(ServerCardError);
        return (error as ServerCardError).code;
    }
}

describe('assertAllowedUrl', () => {
    it('allows https to public hosts', () => {
        expect(codeOf(() => assertAllowedUrl(new URL('https://example.com/x'), {}))).toBeUndefined();
    });

    it('rejects non-http(s) schemes', () => {
        expect(codeOf(() => assertAllowedUrl(new URL('ftp://example.com/x'), {}))).toBe('blocked-host');
        expect(codeOf(() => assertAllowedUrl(new URL('file:///etc/passwd'), {}))).toBe('blocked-host');
    });

    it('rejects plain http to remote hosts unless allowHttp, exempting localhost forms', () => {
        expect(codeOf(() => assertAllowedUrl(new URL('http://example.com/x'), {}))).toBe('blocked-host');
        expect(codeOf(() => assertAllowedUrl(new URL('http://example.com/x'), { allowHttp: true }))).toBeUndefined();
    });

    it.each(['http://localhost:3000/x', 'http://127.0.0.1:3000/x', 'http://[::1]:3000/x', 'https://127.0.0.1/x', 'https://[::1]/x'])(
        'always exempts the local-dev host %s, with no overrides',
        url => {
            expect(codeOf(() => assertAllowedUrl(new URL(url), {}))).toBeUndefined();
        }
    );

    it.each([
        'https://0.0.0.0/x',
        'https://10.1.2.3/x',
        'https://127.0.0.2/x',
        'https://169.254.169.254/latest/meta-data',
        'https://172.16.0.1/x',
        'https://172.31.255.255/x',
        'https://192.168.1.1/x',
        'https://[::]/x',
        'https://[fe80::1]/x',
        'https://[fd00::1]/x',
        'https://[::ffff:127.0.0.1]/x',
        'https://[::ffff:10.0.0.1]/x',
        // Embedded-IPv4 spellings of private targets: IPv4-compatible
        // (`[::127.0.0.1]` URL-normalizes to `[::7f00:1]`), NAT64 well-known
        // prefix, and 6to4.
        'https://[::7f00:1]/x',
        'https://[::a9fe:a9fe]/x',
        'https://[64:ff9b::a9fe:a9fe]/x',
        'https://[64:ff9b::169.254.169.254]/x',
        'https://[2002:7f00:1::]/x',
        'https://[2002:a9fe:a9fe::]/x'
    ])('rejects private or local address %s by default', url => {
        expect(codeOf(() => assertAllowedUrl(new URL(url), {}))).toBe('blocked-host');
    });

    it.each([
        'https://172.15.0.1/x',
        'https://172.32.0.1/x',
        'https://8.8.8.8/x',
        'https://[2606:4700::1]/x',
        // Embedded-IPv4 forms of PUBLIC addresses stay allowed.
        'https://[64:ff9b::808:808]/x',
        'https://[2002:808:808::]/x'
    ])('allows public address %s', url => {
        expect(codeOf(() => assertAllowedUrl(new URL(url), {}))).toBeUndefined();
    });

    it('rejects single-label hostnames other than localhost', () => {
        expect(codeOf(() => assertAllowedUrl(new URL('https://intranet/x'), {}))).toBe('blocked-host');
        expect(codeOf(() => assertAllowedUrl(new URL('https://localhost/x'), {}))).toBeUndefined();
    });

    it('allows everything private with allowPrivateHosts', () => {
        for (const url of ['https://169.254.169.254/x', 'https://192.168.1.1/x', 'https://intranet/x', 'https://[::1]/x']) {
            expect(codeOf(() => assertAllowedUrl(new URL(url), { allowPrivateHosts: true }))).toBeUndefined();
        }
    });
});
