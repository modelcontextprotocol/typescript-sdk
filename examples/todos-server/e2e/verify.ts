/**
 * Self-verifying probe suite for a running todos-server worker (wrangler dev or a
 * live deployment). Covers what the unit-less worker cannot: the OAuth dance,
 * the tier-security invariants (session ids are never credentials), the live
 * board view, and the pages.
 *
 *   pnpm --filter @mcp-examples/todos-server verify                       # against http://127.0.0.1:8850
 *   pnpm --filter @mcp-examples/todos-server verify -- --base https://…   # against a deployment
 *
 * Consent handling auto-detects: a 302 from /authorize means TODOS_AUTO_CONSENT
 * is set (dev); a 200 renders the real consent form, which the suite completes
 * with the double-submit nonce like a browser would.
 */
import { check } from '@mcp-examples/shared';

const baseIndex = process.argv.indexOf('--base');
const BASE = baseIndex === -1 ? 'http://127.0.0.1:8850' : (process.argv[baseIndex + 1] ?? '');
// workers.dev bot protection 403s default non-browser UAs; real MCP clients are unaffected.
const UA = { 'user-agent': 'todos-e2e-verify/1.0' };
const ENVELOPE = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'verify', version: '1.0' },
    'io.modelcontextprotocol/clientCapabilities': {}
};

function b64url(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64url');
}

async function sha256(text: string): Promise<string> {
    return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

interface Grant {
    token: string;
    clientId: string;
    viewerCookie?: string;
}

/** The full authorization-code dance: register, authorize (either consent mode), exchange. */
async function dance(): Promise<Grant> {
    const registerResponse = await fetch(`${BASE}/oauth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...UA },
        body: JSON.stringify({
            client_name: 'e2e-verify',
            redirect_uris: ['http://127.0.0.1:9999/callback'],
            grant_types: ['authorization_code'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none'
        })
    });
    const registered = (await registerResponse.json()) as { client_id: string };

    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: registered.client_id,
        redirect_uri: 'http://127.0.0.1:9999/callback',
        scope: 'todos',
        state: 'verify-state',
        code_challenge: await sha256(verifier),
        code_challenge_method: 'S256'
    });
    let authorize = await fetch(`${BASE}/authorize?${query.toString()}`, { redirect: 'manual', headers: UA });
    if (authorize.status === 200) {
        // Real consent page: complete it the way a browser would.
        const page = await authorize.text();
        const nonce = /name="nonce" value="([^"]+)"/.exec(page)?.[1] ?? '';
        const action = (/action="([^"]+)"/.exec(page)?.[1] ?? '').replaceAll('&amp;', '&');
        const consentCookie = (authorize.headers.get('set-cookie') ?? '').split(';')[0];
        check.ok(nonce.length > 0);
        authorize = await fetch(`${BASE}${action}`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: consentCookie, ...UA },
            body: new URLSearchParams({ nonce }).toString()
        });
    }
    check.equal(authorize.status, 302);
    const viewerCookie = (authorize.headers.get('set-cookie') ?? '').split(';')[0] || undefined;
    const location = new URL(authorize.headers.get('location') ?? '');
    check.equal(location.searchParams.get('state'), 'verify-state');
    const code = location.searchParams.get('code') ?? '';

    const tokenResponse = await fetch(`${BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...UA },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            client_id: registered.client_id,
            redirect_uri: 'http://127.0.0.1:9999/callback',
            code_verifier: verifier
        }).toString()
    });
    const token = (await tokenResponse.json()) as { access_token: string };
    check.ok(token.access_token.length > 0);
    return { token: token.access_token, clientId: registered.client_id, viewerCookie };
}

async function mcp(
    path: string,
    method: string,
    name: string | undefined,
    args: unknown,
    headers: Record<string, string>
): Promise<Response> {
    const params =
        name === undefined
            ? { _meta: ENVELOPE }
            : method === 'tools/call'
              ? { name, arguments: args, _meta: ENVELOPE }
              : { _meta: ENVELOPE };
    return fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': method,
            ...(name === undefined ? {} : { 'mcp-name': name }),
            ...UA,
            ...headers
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
}

async function toolText(response: Response): Promise<string> {
    const raw = await response.text();
    for (const line of raw.split('\n')) {
        if (line.startsWith('data: ')) return JSON.stringify(JSON.parse(line.slice(6)));
    }
    return raw;
}

/** Read SSE frames from a stream until the predicate is satisfied or the timeout hits. */
async function readSse(
    path: string,
    headers: Record<string, string>,
    until: (frames: string[]) => boolean,
    timeoutMs = 12_000
): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const frames: string[] = [];
    try {
        const response = await fetch(`${BASE}${path}`, { headers: { ...UA, ...headers }, signal: controller.signal });
        check.equal(response.status, 200);
        const reader = response.body?.getReader();
        check.ok(reader !== undefined);
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
            const { value, done } = await reader!.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let index: number;
            while ((index = buffer.indexOf('\n\n')) !== -1) {
                frames.push(buffer.slice(0, index));
                buffer = buffer.slice(index + 2);
            }
            if (until(frames)) return frames;
        }
    } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) throw error;
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
    return frames;
}

// ---------------------------------------------------------------------------

console.error(`[verify] target: ${BASE}`);

// 1. Discovery documents are spec-shaped.
const asResponse = await fetch(`${BASE}/.well-known/oauth-authorization-server`, { headers: UA });
const asMetadata = (await asResponse.json()) as Record<string, unknown>;
check.ok((asMetadata.code_challenge_methods_supported as string[]).includes('S256'));
check.equal(asMetadata.client_id_metadata_document_supported, true);
const prmResponse = await fetch(`${BASE}/.well-known/oauth-protected-resource/oauth/mcp`, { headers: UA });
const prm = (await prmResponse.json()) as Record<string, unknown>;
check.equal(prm.resource, `${BASE}/oauth/mcp`);
console.error('[verify] 1. discovery ok');

// 2. Unauthenticated → 401 with a resource_metadata challenge.
const unauth = await mcp('/oauth/mcp', 'tools/list', undefined, {}, {});
check.equal(unauth.status, 401);
check.match(unauth.headers.get('www-authenticate') ?? '', /resource_metadata=/);
console.error('[verify] 2. challenge ok');

// 3. Two grants; boards are isolated; whoami reports the grant.
const grantA = await dance();
const grantB = await dance();
const whoami = await toolText(await mcp('/oauth/mcp', 'tools/call', 'whoami', {}, { authorization: `Bearer ${grantA.token}` }));
check.match(whoami, /Authenticated via OAuth/);
const canaryAdd = await toolText(
    await mcp('/oauth/mcp', 'tools/call', 'add_task', { title: 'canary-A' }, { authorization: `Bearer ${grantA.token}` })
);
check.match(canaryAdd, /canary-A/);
const listB = await toolText(await mcp('/oauth/mcp', 'tools/call', 'list_tasks', {}, { authorization: `Bearer ${grantB.token}` }));
check.ok(!listB.includes('canary-A'));
console.error('[verify] 3. grants + isolation ok');

// 4. Tier security: a session id is never a credential.
const init = await fetch(`${BASE}/oauth/mcp`, {
    method: 'POST',
    headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${grantA.token}`,
        ...UA
    },
    body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify', version: '1.0' } }
    })
});
const sessionId = init.headers.get('mcp-session-id') ?? '';
check.ok(sessionId.length > 0);
// Session requests speak the session's negotiated protocol (2025-06-18): a
// 2026-envelope request on a legacy session is correctly refused.
const onSession = (path: string, headers: Record<string, string>): Promise<Response> =>
    fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sessionId,
            ...UA,
            ...headers
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
const bare = await onSession('/mcp', {});
check.equal(bare.status, 401);
const crossGrant = await onSession('/oauth/mcp', { authorization: `Bearer ${grantB.token}` });
check.equal(crossGrant.status, 404);
const legit = await onSession('/oauth/mcp', { authorization: `Bearer ${grantA.token}` });
check.equal(legit.status, 200);
const viewLeak = await readSse('/board/events', { 'mcp-session-id': sessionId }, frames => frames.some(f => f.startsWith('data: ')), 6000);
// The absence of the canary only proves anything over a stream that produced a snapshot.
check.ok(viewLeak.some(f => f.startsWith('data: ')));
check.ok(!viewLeak.join('').includes('canary-A'));
console.error('[verify] 4. tier security ok');

// 5. Live board view: named board streams its own changes; identity frame is present.
const boardId = `verify-${Math.random().toString(36).slice(2, 10)}`;
// eslint-disable-next-line unicorn/prefer-top-level-await -- deliberately concurrent: the watcher must be listening before the mutation
const watch = readSse(`/board/events?b=${boardId}`, {}, frames => frames.filter(f => f.startsWith('data: ')).length >= 2);
await new Promise(resolve => setTimeout(resolve, 1000));
await mcp('/mcp', 'tools/call', 'add_task', { title: 'seen-live' }, { 'x-todos-board': boardId });
const frames = await watch;
check.ok(frames.some(f => f.includes('"mode":"named"')));
check.ok(frames.some(f => f.includes('seen-live')));
console.error('[verify] 5. board view ok');

// 6. The approve 302 carries the viewer cookie in both consent modes; it must resolve
// to the grant board.
check.ok(grantA.viewerCookie !== undefined);
const viewer = await readSse(
    '/board/events',
    { cookie: grantA.viewerCookie ?? '' },
    frames => frames.some(f => f.includes('"mode"')),
    6000
);
check.ok(viewer.some(f => f.includes('"mode":"oauth"')));
console.error('[verify] 6. viewer cookie ok');

// 7. Pages serve and the board script parses.
const landing = await fetch(`${BASE}/`, { headers: UA });
check.equal(landing.status, 200);
const board = await fetch(`${BASE}/board`, { headers: UA });
const boardPage = await board.text();
check.equal(board.status, 200);
const script = /<script>\n?([\s\S]*?)<\/script>/.exec(boardPage)?.[1] ?? '';
check.ok(script.length > 100);
// This catches the shipped-dead-script class: the inline script must PARSE.
// Compile-only: the constructed function is never invoked, so nothing from the
// target executes here even if --base pointed somewhere hostile.
// eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
new Function(script);
console.error('[verify] 7. pages ok');

// 8. Authorization error paths answer 400, not exceptions.
const badClient = await fetch(`${BASE}/authorize?response_type=code&client_id=nonexistent&redirect_uri=https%3A%2F%2Fx%2Fcb`, {
    redirect: 'manual',
    headers: UA
});
check.equal(badClient.status, 400);
const bareApprove = await fetch(`${BASE}/authorize/approve`, { method: 'POST', redirect: 'manual', headers: UA });
check.equal(bareApprove.status, 400);
console.error('[verify] 8. error paths ok');

// 9. 2026-era cancellation: dropping the request's response stream mid-call MUST
// stop the tool (draft streamable-http). On Workers this needs the
// enable_request_signal compatibility flag — this probe is the regression net.
const cancelBoard = `verify-cancel-${Math.random().toString(36).slice(2, 10)}`;
const onCancelBoard = (name: string, args: unknown): Promise<Response> =>
    mcp('/mcp', 'tools/call', name, args, { 'x-todos-board': cancelBoard });
for (let i = 0; i < 6; i++) await onCancelBoard('add_task', { title: `cancel-target-${i}` });
const dropController = new AbortController();
const longCall = fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'work_through_tasks',
        'x-todos-board': cancelBoard,
        ...UA
    },
    body: JSON.stringify({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'work_through_tasks', arguments: { secondsPerTask: 2 }, _meta: { ...ENVELOPE, progressToken: 'cancel-probe' } }
    }),
    signal: dropController.signal
});
const streaming = await longCall;
check.equal(streaming.status, 200);
// Consume one frame so the exchange is demonstrably live, then drop the connection.
const frameReader = streaming.body?.getReader();
check.ok(frameReader !== undefined);
await frameReader!.read();
await new Promise(resolve => setTimeout(resolve, 2500));
dropController.abort();
await new Promise(resolve => setTimeout(resolve, 12_000));
const survivors = await toolText(await onCancelBoard('list_tasks', {}));
const stillOpen = (survivors.match(/- \[ \]/g) ?? []).length;
check.ok(stillOpen >= 2);
console.error(`[verify] 9. cancellation ok (${stillOpen}/6 tasks spared by the mid-call drop)`);

console.error('[verify] all checks passed');
