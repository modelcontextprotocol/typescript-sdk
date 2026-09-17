import { describe, expect, it } from 'vitest';

import {
    CliOAuthClientProvider,
    completeAuthorizationWithBrowser,
    createOAuthProvider,
    findCallbackPort,
    isSafeBrowserUrl,
    waitForOAuthCallback
} from '../host/auth';
import { ScriptedUI } from '../script/scriptedUi';

/** Poll the loopback callback endpoint until the listener is up, then deliver the query. */
async function deliverCallback(port: number, query: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            await fetch(`http://127.0.0.1:${port}/callback?${query}`);
            return;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }
    throw new Error('callback server never came up');
}

describe('CliOAuthClientProvider', () => {
    it('round-trips the state the SDK stores on it and supports scoped invalidation', () => {
        const provider = createOAuthProvider('todos', 8123);
        expect(provider.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:8123/callback']);

        expect(provider.state()).toBe(provider.state());
        provider.saveTokens({ access_token: 'a', token_type: 'bearer' });
        provider.saveCodeVerifier('verifier');
        provider.saveClientInformation({ client_id: 'client' });
        expect(provider.tokens()?.access_token).toBe('a');
        expect(provider.codeVerifier()).toBe('verifier');
        provider.invalidateCredentials('tokens');
        expect(provider.tokens()).toBeUndefined();
        expect(provider.clientInformation()?.client_id).toBe('client');
        provider.invalidateCredentials('all');
        expect(provider.clientInformation()).toBeUndefined();
    });

    it('defers the redirect instead of opening anything during connect()', () => {
        const provider = new CliOAuthClientProvider('http://localhost:1/callback', { redirect_uris: ['http://localhost:1/callback'] });
        provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?state=s'));
        expect(provider.pendingAuthorizationUrl?.hostname).toBe('auth.example.com');
    });
});

describe('loopback callback server', () => {
    it('resolves with the callback query parameters', async () => {
        const port = await findCallbackPort();
        const callback = waitForOAuthCallback(port);
        await deliverCallback(port, 'code=abc&state=xyz');
        const params = await callback;
        expect(params.get('code')).toBe('abc');
        expect(params.get('state')).toBe('xyz');
    });
});

describe('completeAuthorizationWithBrowser', () => {
    it('does nothing when the user declines', async () => {
        const provider = createOAuthProvider('todos', 8124);
        provider.redirectToAuthorization(new URL('http://127.0.0.1:9/authorize'));
        let exchanged = false;
        const authorized = await completeAuthorizationWithBrowser({
            serverName: 'todos',
            ui: new ScriptedUI({ confirmAnswers: [false] }),
            provider,
            callbackPort: 8124,
            finishAuth: async () => {
                exchanged = true;
            }
        });
        expect(authorized).toBe(false);
        expect(exchanged).toBe(false);
    });

    it('refuses to open a non-https, non-loopback authorization URL', async () => {
        const provider = createOAuthProvider('todos', 8125);
        provider.redirectToAuthorization(new URL('http://auth.example.com/authorize'));
        let opened = false;
        const authorized = await completeAuthorizationWithBrowser({
            serverName: 'todos',
            ui: new ScriptedUI({ confirmAnswers: [true] }),
            provider,
            callbackPort: 8125,
            finishAuth: async () => {},
            openUrl: async () => {
                opened = true;
            }
        });
        expect(authorized).toBe(false);
        expect(opened).toBe(false);
    });

    it('rejects a callback whose state does not match', async () => {
        const port = await findCallbackPort();
        const provider = createOAuthProvider('todos', port);
        const expectedState = provider.state();
        provider.redirectToAuthorization(new URL(`http://127.0.0.1:9/authorize?state=${expectedState}`));
        let exchanged = false;
        const pending = completeAuthorizationWithBrowser({
            serverName: 'todos',
            ui: new ScriptedUI({ confirmAnswers: [true] }),
            provider,
            callbackPort: port,
            finishAuth: async () => {
                exchanged = true;
            },
            openUrl: async () => {}
        });
        await deliverCallback(port, 'code=abc&state=wrong');
        expect(await pending).toBe(false);
        expect(exchanged).toBe(false);
    });

    it('exchanges the code when the state matches', async () => {
        const port = await findCallbackPort();
        const provider = createOAuthProvider('todos', port);
        const expectedState = provider.state();
        provider.redirectToAuthorization(new URL(`http://127.0.0.1:9/authorize?state=${expectedState}`));
        let receivedCode: string | null = null;
        let openedUrl: string | undefined;
        const pending = completeAuthorizationWithBrowser({
            serverName: 'todos',
            ui: new ScriptedUI({ confirmAnswers: [true] }),
            provider,
            callbackPort: port,
            finishAuth: async params => {
                receivedCode = params.get('code');
            },
            openUrl: async url => {
                openedUrl = url;
            }
        });
        await deliverCallback(port, `code=secret-code&state=${expectedState}`);
        expect(await pending).toBe(true);
        expect(receivedCode).toBe('secret-code');
        expect(openedUrl).toBe(`http://127.0.0.1:9/authorize?state=${expectedState}`);
    });
});

describe('isSafeBrowserUrl', () => {
    it('allows https anywhere and http only on loopback', () => {
        expect(isSafeBrowserUrl(new URL('https://example.com/step'))).toBe(true);
        expect(isSafeBrowserUrl(new URL('http://127.0.0.1:8080/cb'))).toBe(true);
        expect(isSafeBrowserUrl(new URL('http://localhost/cb'))).toBe(true);
        expect(isSafeBrowserUrl(new URL('http://[::1]:9000/cb'))).toBe(true);
    });

    it('refuses remote http and non-web schemes', () => {
        expect(isSafeBrowserUrl(new URL('http://example.com/phish'))).toBe(false);
        expect(isSafeBrowserUrl(new URL('file:///etc/passwd'))).toBe(false);
        expect(isSafeBrowserUrl(new URL('javascript:alert(1)'))).toBe(false);
        expect(isSafeBrowserUrl(new URL('ftp://example.com/x'))).toBe(false);
    });
});
