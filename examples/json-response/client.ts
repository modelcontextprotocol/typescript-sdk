/**
 * Asserts the `responseMode: 'json'` server answers a `tools/call` with a
 * `Content-Type: application/json` body (not `text/event-stream`) AND that the
 * regular `Client` works against it unchanged.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { check, httpUrlFromArgs, runClient } from '../harness.js';

const URL = httpUrlFromArgs('http://127.0.0.1:3000/');

runClient('json-response', async () => {
    // Low-level: a 2026-07-28 (envelope) request should come back as plain
    // JSON. (`responseMode` applies to the per-request modern path; 2025-era
    // traffic goes through the stateless legacy fallback unaffected.)
    const probe = await fetch(URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'tools/list'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {
                _meta: {
                    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                    'io.modelcontextprotocol/clientInfo': { name: 'probe', version: '1.0.0' },
                    'io.modelcontextprotocol/clientCapabilities': {}
                }
            }
        })
    });
    check.match(probe.headers.get('content-type') ?? '', /application\/json/);
    check.equal(probe.status, 200);

    // High-level: the regular Client works unchanged.
    const client = new Client({ name: 'json-response-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));
    const result = await client.callTool({ name: 'greet', arguments: { name: 'json' } });
    check.equal(result.content?.[0]?.type === 'text' ? result.content[0].text : '', 'Hello, json!');
    await client.close();
});
