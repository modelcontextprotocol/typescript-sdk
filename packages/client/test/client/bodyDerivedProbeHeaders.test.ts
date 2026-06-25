/**
 * Body-derived per-request headers on the streamable HTTP client transport:
 * when a single outgoing request carries the 2026-07-28 protocol-version claim
 * in its `_meta` envelope (the negotiation probe is the first such sender), the
 * `MCP-Protocol-Version` and `Mcp-Method` headers derive from the message
 * itself. The connection-level version slot is never consulted or mutated for
 * those sends, and envelope-less (2025-era) traffic gets no new headers.
 */
import type { JSONRPCMessage } from '@modelcontextprotocol/core-internal';
import { CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/core-internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp.js';

describe('body-derived probe headers', () => {
    let transport: StreamableHTTPClientTransport;
    let fetchSpy: ReturnType<typeof vi.fn>;

    const okJson = (body: unknown) => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve(body)
    });

    beforeEach(async () => {
        fetchSpy = vi.fn();
        globalThis.fetch = fetchSpy as unknown as typeof fetch;
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
        await transport.start();
    });

    afterEach(async () => {
        await transport.close().catch(() => {});
        vi.restoreAllMocks();
    });

    const probeRequest: JSONRPCMessage = {
        jsonrpc: '2.0',
        id: 'server-discover-probe-1',
        method: 'server/discover',
        params: {
            _meta: {
                [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
                [CLIENT_INFO_META_KEY]: { name: 'c', version: '0' },
                [CLIENT_CAPABILITIES_META_KEY]: {}
            }
        }
    };

    const sentHeaders = (): Headers => {
        const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit;
        return init.headers as Headers;
    };

    it('derives MCP-Protocol-Version and Mcp-Method from the probe message body', async () => {
        fetchSpy.mockResolvedValueOnce(
            okJson({ jsonrpc: '2.0', id: 'server-discover-probe-1', result: { supportedVersions: ['2026-07-28'] } })
        );

        await transport.send(probeRequest);

        const headers = sentHeaders();
        expect(headers.get('mcp-protocol-version')).toBe('2026-07-28');
        expect(headers.get('mcp-method')).toBe('server/discover');
    });

    it('never mutates the transport version slot for body-derived sends', async () => {
        fetchSpy.mockResolvedValueOnce(
            okJson({ jsonrpc: '2.0', id: 'server-discover-probe-1', result: { supportedVersions: ['2026-07-28'] } })
        );

        await transport.send(probeRequest);
        expect(transport.protocolVersion).toBeUndefined();

        // A follow-up envelope-less message gets no version header at all — the
        // slot is still unset; nothing leaked from the probe.
        fetchSpy.mockResolvedValueOnce(okJson({ jsonrpc: '2.0', id: 0, result: {} }));
        await transport.send({ jsonrpc: '2.0', id: 0, method: 'ping', params: {} });

        const headers = sentHeaders();
        expect(headers.get('mcp-protocol-version')).toBeNull();
        expect(headers.get('mcp-method')).toBeNull();
    });

    it('envelope-less (2025-era) requests are untouched: no 2026 headers, slot-driven behavior unchanged', async () => {
        fetchSpy.mockResolvedValueOnce(okJson({ jsonrpc: '2.0', id: 1, result: {} }));
        await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} });

        let headers = sentHeaders();
        expect(headers.get('mcp-protocol-version')).toBeNull();
        expect(headers.get('mcp-method')).toBeNull();
        expect(headers.get('mcp-name')).toBeNull();

        // setProtocolVersion (the legacy post-initialize call site, byte-untouched)
        // still drives the header for subsequent slot-based sends.
        transport.setProtocolVersion('2025-11-25');
        fetchSpy.mockResolvedValueOnce(okJson({ jsonrpc: '2.0', id: 2, result: {} }));
        await transport.send({ jsonrpc: '2.0', id: 2, method: 'ping', params: {} });

        headers = sentHeaders();
        expect(headers.get('mcp-protocol-version')).toBe('2025-11-25');
        expect(headers.get('mcp-method')).toBeNull();
    });

    it('a body-derived claim takes precedence over the slot for its own request only', async () => {
        transport.setProtocolVersion('2025-11-25');

        fetchSpy.mockResolvedValueOnce(
            okJson({ jsonrpc: '2.0', id: 'server-discover-probe-1', result: { supportedVersions: ['2026-07-28'] } })
        );
        await transport.send(probeRequest);
        expect(sentHeaders().get('mcp-protocol-version')).toBe('2026-07-28');

        fetchSpy.mockResolvedValueOnce(okJson({ jsonrpc: '2.0', id: 3, result: {} }));
        await transport.send({ jsonrpc: '2.0', id: 3, method: 'ping', params: {} });
        expect(sentHeaders().get('mcp-protocol-version')).toBe('2025-11-25');
    });

    it('batch (array) sends are never body-derived', async () => {
        fetchSpy.mockResolvedValueOnce(okJson([{ jsonrpc: '2.0', id: 4, result: {} }]));
        await transport.send([probeRequest as never]);

        const headers = sentHeaders();
        expect(headers.get('mcp-protocol-version')).toBeNull();
        expect(headers.get('mcp-method')).toBeNull();
    });
});
