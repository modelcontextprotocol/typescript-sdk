import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type {
    OAuthClientInformationMixed,
    OAuthClientMetadata,
    OAuthClientProvider,
    OAuthDiscoveryState,
    OAuthTokens
} from '@modelcontextprotocol/client';
import open from 'open';

import type { HostUI } from './ui';

/**
 * In-memory OAuth provider for an interactive CLI host. Tokens live for the lifetime of the
 * process; a real host would persist them in the platform keychain. The SDK drives the whole
 * authorization-code + PKCE flow — the host only supplies storage, the redirect hook, and the
 * `state` value it must verify when the callback comes back.
 */
export class CliOAuthClientProvider implements OAuthClientProvider {
    private clientInfo?: OAuthClientInformationMixed;
    private oauthTokens?: OAuthTokens;
    private verifier?: string;
    private discovery?: OAuthDiscoveryState;
    private currentState?: string;
    /** The authorization URL the SDK asked us to open (deferred until the user approves). */
    pendingAuthorizationUrl?: URL;

    constructor(
        readonly redirectUrl: string,
        readonly clientMetadata: OAuthClientMetadata
    ) {}

    state(): string {
        this.currentState ??= crypto.randomUUID();
        return this.currentState;
    }

    /** The SDK never checks `state` itself — the host must compare this against the callback. */
    get expectedState(): string | undefined {
        return this.currentState;
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
        return this.clientInfo;
    }

    saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
        this.clientInfo = clientInformation;
    }

    tokens(): OAuthTokens | undefined {
        return this.oauthTokens;
    }

    saveTokens(tokens: OAuthTokens): void {
        this.oauthTokens = tokens;
    }

    redirectToAuthorization(authorizationUrl: URL): void {
        // connect() is already in flight here, so just remember the URL; the host opens the
        // browser only after the user has agreed to authorize this server.
        this.pendingAuthorizationUrl = authorizationUrl;
    }

    saveCodeVerifier(codeVerifier: string): void {
        this.verifier = codeVerifier;
    }

    codeVerifier(): string {
        if (!this.verifier) throw new Error('No code verifier saved');
        return this.verifier;
    }

    saveDiscoveryState(state: OAuthDiscoveryState): void {
        this.discovery = state;
    }

    discoveryState(): OAuthDiscoveryState | undefined {
        return this.discovery;
    }

    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
        if (scope === 'all' || scope === 'client') this.clientInfo = undefined;
        if (scope === 'all' || scope === 'tokens') this.oauthTokens = undefined;
        if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
        if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
    }
}

export function createOAuthProvider(serverName: string, callbackPort: number): CliOAuthClientProvider {
    const callbackUrl = `http://127.0.0.1:${callbackPort}/callback`;
    return new CliOAuthClientProvider(callbackUrl, {
        client_name: `cli-client (${serverName})`,
        redirect_uris: [callbackUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
        token_endpoint_auth_method: 'none'
    });
}

/** Start a loopback HTTP server on 127.0.0.1 and resolve with the OAuth callback's query parameters. */
export function waitForOAuthCallback(port: number): Promise<URLSearchParams> {
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            const requestUrl = new URL(req.url ?? '/', 'http://localhost');
            if (requestUrl.pathname !== '/callback') {
                res.writeHead(404).end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authorization received</h1><p>You can close this window and return to cli-client.</p></body></html>');
            resolve(requestUrl.searchParams);
            setTimeout(() => server.close(), 1000);
        });
        server.on('error', reject);
        server.listen(port, '127.0.0.1');
    });
}

/** A free loopback port for the OAuth callback, picked by the OS. */
export async function findCallbackPort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as AddressInfo;
            probe.close(() => resolve(port));
        });
    });
}

function isLoopbackHost(hostname: string): boolean {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/**
 * True when a server-supplied URL is safe to hand to the system browser: `https:`, or `http:`
 * on a loopback host. Everything else (`file:`, `javascript:`, plain http to a remote host)
 * fails closed. Shared by the OAuth flow and URL-mode elicitation.
 */
export function isSafeBrowserUrl(url: URL): boolean {
    return url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackHost(url.hostname));
}

/**
 * Complete an interactive OAuth flow after `connect()` failed with `UnauthorizedError`:
 * confirm with the user, open the system browser, wait for the loopback callback, verify
 * `state`, and let the transport exchange the code (`finishAuth`). The caller then reconnects
 * on a fresh transport with the same provider.
 */
export async function completeAuthorizationWithBrowser(options: {
    serverName: string;
    ui: HostUI;
    provider: CliOAuthClientProvider;
    callbackPort: number;
    finishAuth: (callbackParams: URLSearchParams) => Promise<void>;
    /** Overridable so tests (or hosts with their own browser handling) don't shell out. */
    openUrl?: (url: string) => Promise<void>;
}): Promise<boolean> {
    const { serverName, ui, provider, callbackPort, finishAuth } = options;
    const openUrl = options.openUrl ?? (async (url: string) => void (await open(url)));
    const authorizationUrl = provider.pendingAuthorizationUrl;
    if (!authorizationUrl) return false;
    // The authorization endpoint comes from server-controlled discovery metadata — never hand
    // a non-https (or non-loopback) URL to the browser, and show the user where they're going.
    if (!isSafeBrowserUrl(authorizationUrl)) {
        ui.status(`skipping "${serverName}" — refusing to open non-https authorization URL (${authorizationUrl.origin})`);
        return false;
    }
    ui.attention(`[authorization]\nServer "${serverName}" requires authorization at ${authorizationUrl.origin}.`);
    const approved = await ui.confirm('Open your browser to sign in?');
    if (!approved) {
        ui.status(`skipping "${serverName}" — authorization declined`);
        return false;
    }
    const callback = waitForOAuthCallback(callbackPort);
    // Attach a handler immediately so a listen failure can't become an unhandled rejection
    // while the browser-open is still in flight.
    callback.catch(() => {});
    ui.status(`opening ${authorizationUrl.toString()}`);
    try {
        await openUrl(authorizationUrl.toString());
    } catch {
        ui.print(`Could not open a browser automatically. Please open:\n${authorizationUrl.toString()}`);
    }
    let params: URLSearchParams;
    try {
        params = await callback;
    } catch (error) {
        ui.status(`authorization for "${serverName}" failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
    }
    if (params.get('error')) {
        // Do not echo error_description — it is attacker-controllable in mix-up attacks.
        ui.status(`authorization for "${serverName}" failed`);
        return false;
    }
    // Fail closed: no recorded state (or a mismatch) means the callback cannot be trusted.
    const expectedState = provider.expectedState;
    if (!expectedState || params.get('state') !== expectedState) {
        ui.status(`authorization for "${serverName}" rejected: state mismatch`);
        return false;
    }
    await finishAuth(params);
    return true;
}
