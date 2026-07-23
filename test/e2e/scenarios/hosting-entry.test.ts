/**
 * Core cells for the dual-era HTTP entry (`createMcpHandler`), exercised
 * through the wire() entry arms: `entryStateless` hosts the entry's stateless
 * legacy fallback (the default posture) for plain 2025-era clients (2025-11-25
 * axis) and `entryModern` hosts the modern-only strict (`legacy: 'reject'`)
 * endpoint for negotiating clients (2026-07-28 axis). Raw wire facts (request
 * bodies, statuses, response bytes) are asserted on the arm-recorded
 * `wired.httpLog`; raw HTTP probes go through `wired.fetch` so every exchange
 * still rides the harness-hosted entry.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core-internal';
import type { McpRequestContext } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { modernEnvelopeMeta, wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';

/** One ctx-taking factory backing every cell: the era only shows up in the tool output so tests can see which leg served the call. */
function greetFactory(ctx?: McpRequestContext): McpServer {
    const server = new McpServer({ name: 'e2e-entry', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
        content: [{ type: 'text', text: `hello ${name} (${ctx?.era ?? 'unknown'})` }]
    }));
    return server;
}

verifies('typescript:hosting:entry:dual-era-one-factory', async ({ transport }: TestArgs) => {
    // Both cells host the same handler shape — one ctx-taking factory, the
    // 'stateless' legacy posture — driven by a plain client; the entry arm
    // decides which era serves it (entryModern pins the client to 2026-07-28).
    const client = new Client({ name: 'dual-era-client', version: '1.0.0' });
    await using wired = await wire(transport, greetFactory, client, { entry: { legacy: 'stateless' } });

    if (transport === 'entryStateless') {
        // 2025-era leg: a plain client is served per request through the
        // stateless legacy fallback — initialize → tools/list → tools/call.
        expect(client.getNegotiatedProtocolVersion()).toBe(LEGACY);
        const tools = await client.listTools();
        expect(tools.tools.map(tool => tool.name)).toEqual(['greet']);
        const result = await client.callTool({ name: 'greet', arguments: { name: 'old friend' } });
        expect(result.content).toEqual([{ type: 'text', text: 'hello old friend (legacy)' }]);
        return;
    }

    // 2026-era leg: the arm-pinned client reaches 2026-07-28 via
    // server/discover — never initialize — and tools/call is served with the
    // per-request envelope (the modern factory leg answers, not the slot).
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    const requestBodies = () => (wired.httpLog ?? []).map(exchange => exchange.requestBody ?? '');
    // The "(never initialize)" clause of the requirement, asserted on the
    // recorded wire traffic: no request body ever carried an initialize,
    // and the negotiation rode server/discover.
    expect(requestBodies().some(body => body.includes('"initialize"'))).toBe(false);
    expect(requestBodies().some(body => body.includes('server/discover'))).toBe(true);
    const result = await client.callTool({ name: 'greet', arguments: { name: 'new friend' } });
    expect(result.content).toEqual([{ type: 'text', text: 'hello new friend (modern)' }]);
    // ...and still no initialize anywhere on the wire after the tool call —
    // the whole conversation rode the modern handshake.
    expect(requestBodies().some(body => body.includes('"initialize"'))).toBe(false);
});

verifies('typescript:hosting:entry:pin-negotiation', async ({ transport }: TestArgs) => {
    // Strict endpoint (legacy: 'reject' — the entryModern arm hosting): the pinned client never needs the legacy leg.
    const client = new Client({ name: 'pin-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await using wired = await wire(transport, greetFactory, client);

    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    const requestBodies = () => (wired.httpLog ?? []).map(exchange => exchange.requestBody ?? '');
    // No initialize was ever put on the wire; the first request is the discover probe.
    expect(requestBodies().some(body => body.includes('"initialize"'))).toBe(false);
    expect(requestBodies()[0]).toContain('server/discover');

    const result = await client.callTool({ name: 'greet', arguments: { name: 'pinned' } });
    expect(result.content).toEqual([{ type: 'text', text: 'hello pinned (modern)' }]);
    // The tool call rode the per-request envelope on the wire...
    const callBody = requestBodies().find(body => body.includes('"tools/call"'));
    expect(callBody).toBeDefined();
    expect(callBody).toContain(PROTOCOL_VERSION_META_KEY);
    // ...and still no initialize anywhere on the wire after the tool call.
    expect(requestBodies().some(body => body.includes('"initialize"'))).toBe(false);
});

verifies('typescript:client:connect:prior-zero-roundtrip', async ({ transport }: TestArgs) => {
    // Bootstrap: the wired negotiating client (the entryModern arm pins it to
    // the modern revision) populates getDiscoverResult().
    const bootstrap = new Client({ name: 'bootstrap', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await using wired = await wire(transport, greetFactory, bootstrap);
    const discover = bootstrap.getDiscoverResult();
    expect(discover).toBeDefined();
    expect(discover!.supportedVersions).toContain(MODERN);

    // Fresh worker → SAME hosted server, connect({ prior }): zero round trips.
    const before = wired.httpLog!.length;
    const worker = new Client({ name: 'worker', version: '1.0.0' });
    await worker.connect(new StreamableHTTPClientTransport(wired.url!, { fetch: wired.fetch }), {
        prior: { kind: 'modern', discover: discover! }
    });
    try {
        // No HTTP exchange was added by the worker's connect().
        expect(wired.httpLog!.length).toBe(before);
        expect(worker.getNegotiatedProtocolVersion()).toBe(MODERN);
        // First wire traffic from the worker is the tools/call itself.
        const result = await worker.callTool({ name: 'greet', arguments: { name: 'prior' } });
        expect(result.content).toEqual([{ type: 'text', text: 'hello prior (modern)' }]);
        expect(wired.httpLog!.length).toBe(before + 1);
        expect(wired.httpLog![before]!.requestBody).toContain('"tools/call"');
    } finally {
        await worker.close().catch(() => {});
    }
});

verifies('typescript:hosting:entry:strict-rejects-legacy', async ({ transport }: TestArgs) => {
    // legacy: 'reject' → modern-only strict (the entryModern arm hosting): no silent 2025 serving.
    const modernClient = new Client({ name: 'strict-modern-client', version: '1.0.0' }, { versionNegotiation: { mode: { pin: MODERN } } });
    await using wired = await wire(transport, greetFactory, modernClient);

    // The documented strict cell over plain HTTP: a 2025-shaped initialize is
    // answered with the unsupported-protocol-version error naming the
    // supported modern revisions (the numeric code is not pinned here).
    const response = await wired.fetch!(wired.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'plain-2025-client', version: '1.0.0' } }
        })
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number; message: string; data?: { supported?: string[] } } };
    expect(body.error.message).toMatch(/unsupported protocol version/i);
    expect(body.error.data?.supported).toContain(MODERN);

    // The plain SDK client sees the same rejection at connect time.
    const plainClient = new Client({ name: 'plain-2025-client', version: '1.0.0' });
    try {
        await expect(plainClient.connect(new StreamableHTTPClientTransport(wired.url!, { fetch: wired.fetch }))).rejects.toThrow(
            /Unsupported protocol version|400/
        );
    } finally {
        await plainClient.close().catch(() => {});
    }
});

verifies('typescript:hosting:entry:notification-202', async ({ transport }: TestArgs) => {
    const client = new Client({ name: 'notify-client', version: '1.0.0' });
    await using wired = await wire(transport, greetFactory, client);

    // 2025 leg: an envelope-less notification rides the legacy stateless slot.
    // 2026 leg: the notification carries the per-request envelope and a method
    // the 2026-07-28 registry defines.
    const notification =
        transport === 'entryStateless'
            ? { jsonrpc: '2.0', method: 'notifications/initialized' }
            : {
                  jsonrpc: '2.0',
                  method: 'notifications/cancelled',
                  params: {
                      requestId: 'never-issued',
                      reason: 'probe',
                      _meta: modernEnvelopeMeta({ name: 'notify-client', version: '1.0.0' })
                  }
              };

    const response = await wired.fetch!(wired.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(notification)
    });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
});
