/**
 * OAuth glue for the todos worker: `@cloudflare/workers-oauth-provider` is the
 * Authorization Server (endpoints, token issuance, client registration — both
 * RFC 7591 dynamic registration and Client ID Metadata Documents), and the
 * MCP handler stays a pure Resource Server consumer: the provider verifies
 * tokens on the API route and this module maps the grant's `props` into the
 * SDK's `AuthInfo`.
 *
 * The demo has no user accounts. The principal is the board: approving the
 * consent screen mints a fresh board id into the grant's props, so the token
 * IS the board — private, portable, and immune to egress-IP rotation. Real
 * deployments replace exactly one thing: the consent step authenticates a
 * user (their IdP) instead of minting an anonymous board.
 */
import type { AuthInfo } from '@modelcontextprotocol/server';

/** What `completeAuthorization` stores and every authorized request gets back. */
export interface TodosGrantProps {
    boardId: string;
    clientId: string;
    scopes: string[];
}

/**
 * The canonical mapping from the provider's grant props to the SDK's
 * `AuthInfo`. The provider attaches only `props` after verifying a token, so
 * everything `AuthInfo` needs must be embedded at grant time (clientId,
 * scopes); the raw token comes from the request header. `expiresAt` is omitted
 * because the provider verifies the token on every request that reaches the
 * API route — including every request of a 2025-era session, which the worker
 * refuses unless it arrives through the provider-verified route — so expiry
 * and revocation cut access without the app tracking timestamps.
 */
export function propsToAuthInfo(props: TodosGrantProps, request: Request): AuthInfo {
    return {
        token: request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '',
        clientId: props.clientId,
        scopes: props.scopes
    };
}

/** Minimal structural slice of the KV namespace the viewer sessions use. */
export interface ViewerSessionStore {
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    get(key: string): Promise<string | null>;
}

/** The provider helpers the worker uses (subset of OAuthHelpers we touch). */
export interface OAuthHelpers {
    parseAuthRequest(request: Request): Promise<{ clientId: string; scope: string[]; state: string; redirectUri: string }>;
    lookupClient(clientId: string): Promise<{ clientId: string; clientName?: string; redirectUris: string[] } | null>;
    completeAuthorization(options: {
        request: unknown;
        userId: string;
        metadata: Record<string, unknown>;
        scope: string[];
        props: TodosGrantProps;
    }): Promise<{ redirectTo: string }>;
}

function escapeHtml(value: string): string {
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function consentPage(clientName: string, scopes: string[], approveAction: string, nonce: string): string {
    return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize — todos demo</title>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1>Authorize ${escapeHtml(clientName)}</h1>
<p><strong>${escapeHtml(clientName)}</strong> is asking for access with scope
<code>${escapeHtml(scopes.join(' '))}</code>.</p>
<p>This demo has no accounts: approving creates a <strong>fresh private todo board</strong>
bound to this authorization. Whoever holds the resulting token holds the board.
A real deployment would sign you in here instead.</p>
<p>After approving, open <a href="/board">/board</a> in this browser to watch the
board update live while your client works.</p>
<form method="post" action="${escapeHtml(approveAction)}" onsubmit="window.open('/board', '_blank')">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<button type="submit" style="font-size: 1.1rem; padding: 0.5rem 1.5rem">Approve &amp; open live board</button>
</form>
<p style="color: #666; font-size: 0.9rem">Approving finishes the sign-in in this tab and opens your board's
live view in a new one (or open <a href="/board" target="_blank">/board</a> yourself afterwards).</p>
</body>`;
}

/**
 * GET /authorize — parse the request, show consent (or auto-approve when the
 * TODOS_AUTO_CONSENT var is set, which the scripted end-to-end dance uses).
 * POST /authorize/approve — mint the board and complete the grant.
 *
 * The original OAuth query parameters ride along to the approve action so the
 * provider re-parses them there; the provider itself validates client and
 * redirect URI on completion. Approval is bound to the rendered consent page
 * by a double-submit nonce (HttpOnly cookie + hidden field), so a bare POST
 * can never mint a grant.
 */
export async function handleAuthorize(
    request: Request,
    provider: OAuthHelpers,
    autoConsent: boolean,
    viewerSessions: ViewerSessionStore
): Promise<Response> {
    const url = new URL(request.url);
    // Routine client mistakes (unknown client_id, mismatched redirect_uri, disabled
    // flows) must answer 400, not surface as worker exceptions.
    let oauthRequest: Awaited<ReturnType<OAuthHelpers['parseAuthRequest']>>;
    let client: Awaited<ReturnType<OAuthHelpers['lookupClient']>>;
    try {
        oauthRequest = await provider.parseAuthRequest(request);
        client = await provider.lookupClient(oauthRequest.clientId);
    } catch (error) {
        console.warn('authorize request rejected:', error);
        return new Response('Invalid authorization request.\n', { status: 400 });
    }
    if (!client) {
        return new Response('Unknown client.\n', { status: 400 });
    }

    const approve = async (): Promise<Response> => {
        const boardId = crypto.randomUUID();
        const scopes = oauthRequest.scope.length > 0 ? oauthRequest.scope : ['todos'];
        const { redirectTo } = await provider.completeAuthorization({
            request: oauthRequest,
            userId: boardId,
            metadata: { minted: new Date().toISOString() },
            scope: scopes,
            props: { boardId, clientId: oauthRequest.clientId, scopes }
        });
        // The one moment the human is in the browser: claiming the live view rides
        // the approval. The cookie is an opaque KV-backed session (no token, no board
        // id in any URL); /board with no ?b= resolves it to this grant's board.
        const viewerId = crypto.randomUUID();
        await viewerSessions.put(
            `viewer:${viewerId}`,
            JSON.stringify({ boardId, clientName: client?.clientName ?? oauthRequest.clientId }),
            { expirationTtl: 7200 }
        );
        return new Response(null, {
            status: 302,
            headers: {
                location: redirectTo,
                'set-cookie': `todos_viewer=${viewerId}; Path=/board; Max-Age=7200; HttpOnly; Secure; SameSite=Lax`
            }
        });
    };

    // Approval happens ONLY on the dedicated approve action, bound to the consent
    // page by a double-submit nonce (cookie + hidden field). A POST to /authorize
    // itself (spec-permitted for the request) renders consent like a GET does.
    if (url.pathname === '/authorize/approve' && request.method === 'POST') {
        const form = await request.formData().catch(() => {});
        const submitted = form?.get('nonce');
        const cookieNonce = /(?:^|;\s*)todos_consent=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
        if (typeof submitted !== 'string' || submitted.length === 0 || submitted !== cookieNonce) {
            return new Response('Consent expired — reopen the authorization link.\n', { status: 400 });
        }
        return approve();
    }
    if (autoConsent) {
        return approve();
    }
    const nonce = crypto.randomUUID();
    const clientName = client.clientName ?? client.clientId;
    return new Response(consentPage(clientName, oauthRequest.scope, `/authorize/approve?${url.searchParams.toString()}`, nonce), {
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'set-cookie': `todos_consent=${nonce}; Path=/authorize; Max-Age=600; HttpOnly; Secure; SameSite=Lax`
        }
    });
}
