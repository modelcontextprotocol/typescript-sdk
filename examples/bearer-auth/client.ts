/**
 * Asserts a bare request is `401` with a `WWW-Authenticate` header, and that
 * a request with `Authorization: Bearer demo-token` reaches the `whoami` tool
 * with the verified `authInfo`.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { check, httpUrlFromArgs, negotiationFromArgs, runClient } from '../harness.js';

const URL = httpUrlFromArgs('http://127.0.0.1:3000/mcp');

runClient('bearer-auth', async () => {
    // Unauthenticated → 401 + WWW-Authenticate.
    const unauth = await fetch(URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })
    });
    check.equal(unauth.status, 401);
    check.match(unauth.headers.get('www-authenticate') ?? '', /Bearer/);

    // Authenticated → 200 and the tool sees the authInfo. Bearer auth is
    // HTTP-layer and era-agnostic; `negotiationFromArgs()` honours `--legacy`.
    const client = new Client({ name: 'bearer-auth-client', version: '1.0.0' }, { versionNegotiation: negotiationFromArgs() });
    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL), { authProvider: { token: async () => 'demo-token' } }));
    const result = await client.callTool({ name: 'whoami', arguments: {} });
    check.equal(result.content?.[0]?.type === 'text' ? result.content[0].text : '', 'client=demo-client');
    await client.close();
});
