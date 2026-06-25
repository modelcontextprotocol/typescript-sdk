/**
 * B-2 rule pin: hand-wired legacy-transport traffic is NEVER
 * Protocol-classified.
 *
 * Discriminator: messages delivered by the hand-wired streamable HTTP server
 * transport carry `extra.request` (the HTTP side channel) but `extra.classification`
 * stays UNSET — the carrier exists for edge classifiers (the 2026 entry), and
 * the Protocol layer must not classify on their behalf. A modern-stamped body
 * (full 2026 `_meta` envelope) pushed through a legacy transport gets today's
 * exact legacy semantics, byte-identical to the same body without the envelope
 * claim where the envelope does not participate (the reserved keys are lifted
 * from `_meta`, exactly as for any legacy request carrying them).
 */
import type { MessageExtraInfo } from '@modelcontextprotocol/core-internal';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { Server } from '../../src/server/server.js';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp.js';

const MODERN = '2026-07-28';

async function setupHandWired() {
    const server = new Server({ name: 'pin-server', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/call', async () => ({ content: [{ type: 'text', text: 'pinned' }] }));
    server.setRequestHandler('tools/list', async () => ({ tools: [] }));

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
    });
    await server.connect(transport);

    // Hand-wired observation point: chain onto the transport callback the same
    // way a consumer wrapping the transport would (wrappable-after-connect).
    const seen: Array<{ method?: string; extra?: MessageExtraInfo }> = [];
    const previous = transport.onmessage;
    transport.onmessage = (message, extra) => {
        seen.push({ method: (message as { method?: string }).method, extra });
        previous?.(message, extra);
    };

    const post = async (body: unknown): Promise<{ status: number; text: string }> => {
        const response = await transport.handleRequest(
            new Request('http://localhost/mcp', {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
                body: JSON.stringify(body)
            })
        );
        return { status: response.status, text: await response.text() };
    };

    return { server, transport, seen, post };
}

const toolsCall = (meta?: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: {
        name: 'anything',
        arguments: {},
        ...(meta !== undefined && { _meta: meta })
    }
});

const modernEnvelope = {
    [PROTOCOL_VERSION_META_KEY]: MODERN,
    [CLIENT_INFO_META_KEY]: { name: 'modern-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

describe('B-2: hand-wired legacy-transport traffic is never Protocol-classified', () => {
    it('extra.request is set and extra.classification stays unset for every delivered message', async () => {
        const { server, seen, post } = await setupHandWired();

        await post(toolsCall());
        await post(toolsCall(modernEnvelope));

        expect(seen.length).toBeGreaterThanOrEqual(2);
        for (const { extra } of seen) {
            expect(extra?.request).toBeInstanceOf(Request);
            expect(extra?.classification).toBeUndefined();
        }

        await server.close();
    });

    it('a modern-stamped body through the legacy transport gets today’s exact legacy semantics, byte-identical', async () => {
        const plainSetup = await setupHandWired();
        const plainResponse = await plainSetup.post(toolsCall());
        await plainSetup.server.close();

        const stampedSetup = await setupHandWired();
        const stampedResponse = await stampedSetup.post(toolsCall(modernEnvelope));
        await stampedSetup.server.close();

        // Byte-identical response: the envelope claim does not flip an era, does
        // not change the result shape, does not get echoed back.
        expect(stampedResponse.status).toBe(plainResponse.status);
        expect(stampedResponse.text).toBe(plainResponse.text);
        expect(stampedResponse.text).toContain('pinned');
        expect(stampedResponse.text).not.toContain(MODERN);
    });

    it('a modern-stamped initialize through the legacy transport negotiates exactly like today (no modern era)', async () => {
        const { server, post } = await setupHandWired();

        const { status, text } = await post({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
                protocolVersion: MODERN,
                capabilities: {},
                clientInfo: { name: 'modern-client', version: '1.0.0' },
                _meta: modernEnvelope
            }
        });

        expect(status).toBe(200);
        const parsed = JSON.parse(text) as { result: { protocolVersion: string } };
        // Today's exact legacy semantics: the unknown requested version is
        // countered with the latest released version; the body stamp does not
        // make the legacy transport modern.
        expect(parsed.result.protocolVersion).toBe('2025-11-25');

        await server.close();
    });
});
