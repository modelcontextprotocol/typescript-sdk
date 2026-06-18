/**
 * `server/discover` machinery + era-aware supported-version list semantics:
 *
 * - the handler is installed ONLY when the server's supported-versions list
 *   carries a modern (2026-07-28+) revision; default servers keep answering
 *   -32601 byte-identically to the deployed fleet
 * - the advertisement is modern-only (DV-30) and carries the
 *   listChanged/subscribe-class capabilities (the spec keeps the bits at
 *   2026-07-28; A11 rider discharged with the subscriptions/listen milestone)
 * - counter-offer ordering: with era-aware list semantics in place, a legacy
 *   initialize can never meet a modern version string at the counter-offer
 *   site, even when the supported list carries one — the guard that must hold
 *   BEFORE any LATEST/SUPPORTED constant bump.
 *
 * Era is instance state: an inbound `server/discover` is served only by a
 * modern-era instance (the method is physically absent from the legacy
 * registry). Production marking of modern instances is owned by the
 * server-entry milestone; these tests mark instances through the
 * package-internal hook the entry will use, and the modern-era request shape
 * carries the required per-request `_meta` envelope.
 */
import type { DiscoverResult, JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/core';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    DiscoverResultSchema,
    InitializeResultSchema,
    InMemoryTransport,
    isJSONRPCErrorResponse,
    isJSONRPCResultResponse,
    LATEST_PROTOCOL_VERSION,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';
import { describe, expect, it } from 'vitest';

import { discoverAdvertisedCapabilities, Server } from '../../src/server/server.js';

const MODERN = '2026-07-28';
/** A supported list spanning both eras — what the constant becomes after a future bump. */
const DUAL_ERA_VERSIONS = [MODERN, ...SUPPORTED_PROTOCOL_VERSIONS];

async function sendRaw(server: Server, request: JSONRPCRequest, options?: { markModern?: boolean }): Promise<JSONRPCMessage> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    if (options?.markModern) {
        // Stand-in for the modern-era server entry (instance binding): mark the
        // instance as serving the modern era so the era gate admits the method.
        setNegotiatedProtocolVersion(server, MODERN);
    }
    const responsePromise = new Promise<JSONRPCMessage>(resolve => {
        clientTransport.onmessage = msg => resolve(msg);
    });
    await clientTransport.start();
    await clientTransport.send(request);
    return responsePromise;
}

/** A wire-true modern discover request: the 2026 era requires the per-request `_meta` envelope. */
const discoverRequest: JSONRPCRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: {
        _meta: {
            [PROTOCOL_VERSION_META_KEY]: MODERN,
            [CLIENT_INFO_META_KEY]: { name: 'test-client', version: '1.0.0' },
            [CLIENT_CAPABILITIES_META_KEY]: {}
        }
    }
};

const initializeRequest = (requestedVersion: string): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: requestedVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } }
});

describe('server/discover handler gating', () => {
    it('a default (legacy-only) server answers server/discover with -32601, byte-identical to the deployed fleet', async () => {
        const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });
        const response = await sendRaw(server, discoverRequest);
        expect(isJSONRPCErrorResponse(response)).toBe(true);
        if (isJSONRPCErrorResponse(response)) {
            expect(response.error.code).toBe(-32_601);
        }
        await server.close();
    });

    it('a server with a modern revision in its supported list serves discover on a modern-era instance', async () => {
        const server = new Server(
            { name: 'modern-server', version: '2.0.0' },
            { capabilities: { tools: {} }, supportedProtocolVersions: DUAL_ERA_VERSIONS, instructions: 'hello' }
        );
        const response = await sendRaw(server, discoverRequest, { markModern: true });
        expect(isJSONRPCResultResponse(response)).toBe(true);
        if (isJSONRPCResultResponse(response)) {
            const result = DiscoverResultSchema.parse(response.result);
            expect(result.supportedVersions).toEqual([MODERN]);
            expect(result.serverInfo).toEqual({ name: 'modern-server', version: '2.0.0' });
            expect(result.instructions).toBe('hello');
        }
        await server.close();
    });

    it('a modern-era instance whose supported list carries no modern revision still answers -32601 (handler not installed)', async () => {
        const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });
        const response = await sendRaw(server, discoverRequest, { markModern: true });
        expect(isJSONRPCErrorResponse(response)).toBe(true);
        if (isJSONRPCErrorResponse(response)) {
            expect(response.error.code).toBe(-32_601);
        }
        await server.close();
    });
});

describe('discover advertisement constraints', () => {
    it('advertises modern-only versions (DV-30): no 2025-era string ever appears in supportedVersions', async () => {
        const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {}, supportedProtocolVersions: DUAL_ERA_VERSIONS });
        const response = await sendRaw(server, discoverRequest, { markModern: true });
        if (!isJSONRPCResultResponse(response)) throw new Error('expected result');
        const result = DiscoverResultSchema.parse(response.result);
        expect(result.supportedVersions).toEqual([MODERN]);
        for (const version of result.supportedVersions) {
            expect(version >= MODERN).toBe(true);
        }
        await server.close();
    });

    it('advertises listChanged/subscribe-class capabilities (A11 rider discharged: subscriptions/listen is served)', async () => {
        const server = new Server(
            { name: 'test', version: '1.0.0' },
            {
                capabilities: {
                    tools: { listChanged: true },
                    prompts: { listChanged: true },
                    resources: { listChanged: true, subscribe: true },
                    logging: {},
                    completions: {}
                },
                supportedProtocolVersions: DUAL_ERA_VERSIONS
            }
        );
        const response = await sendRaw(server, discoverRequest, { markModern: true });
        if (!isJSONRPCResultResponse(response)) throw new Error('expected result');
        const result = DiscoverResultSchema.parse(response.result) as DiscoverResult;

        expect(result.capabilities.tools).toEqual({ listChanged: true });
        expect(result.capabilities.prompts).toEqual({ listChanged: true });
        expect(result.capabilities.resources).toEqual({ listChanged: true, subscribe: true });
        expect(result.capabilities.logging).toEqual({});
        expect(result.capabilities.completions).toEqual({});

        await server.close();
    });

    it('discoverAdvertisedCapabilities is pure and leaves the initialize advertisement untouched', async () => {
        const capabilities = { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } };
        const advertised = discoverAdvertisedCapabilities(capabilities);
        expect(advertised).toEqual({ tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } });
        // No mutation / aliasing of the input.
        expect(advertised).not.toBe(capabilities);
        expect(capabilities).toEqual({ tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } });

        // The legacy initialize advertisement still carries the full capability set.
        const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities, supportedProtocolVersions: DUAL_ERA_VERSIONS });
        const response = await sendRaw(server, initializeRequest(LATEST_PROTOCOL_VERSION));
        if (!isJSONRPCResultResponse(response)) throw new Error('expected result');
        const result = InitializeResultSchema.parse(response.result);
        expect(result.capabilities.tools).toEqual({ listChanged: true });
        expect(result.capabilities.resources).toEqual({ subscribe: true, listChanged: true });
        await server.close();
    });
});

describe('era-aware counter-offer ordering (the guard that precedes any constant bump)', () => {
    it('an unknown requested version is countered with the latest LEGACY version even when the list carries a modern one', async () => {
        const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {}, supportedProtocolVersions: DUAL_ERA_VERSIONS });
        const response = await sendRaw(server, initializeRequest('1999-01-01'));
        if (!isJSONRPCResultResponse(response)) throw new Error('expected result');
        const result = InitializeResultSchema.parse(response.result);
        // supportedProtocolVersions[0] is the modern revision here — the
        // counter-offer must NOT be it: a fallback initialize never meets a
        // leaked 2026 string at this site.
        expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
        expect(result.protocolVersion).not.toBe(MODERN);
        await server.close();
    });

    it('an initialize REQUESTING the modern revision is also answered with the latest legacy version (initialize never negotiates a modern era)', async () => {
        const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {}, supportedProtocolVersions: DUAL_ERA_VERSIONS });
        const response = await sendRaw(server, initializeRequest(MODERN));
        if (!isJSONRPCResultResponse(response)) throw new Error('expected result');
        const result = InitializeResultSchema.parse(response.result);
        expect(result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
        expect(server.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);
        await server.close();
    });

    it('default-list behavior is byte-identical: the legacy subset IS the whole list today', async () => {
        const server = new Server({ name: 'test', version: '1.0.0' }, { capabilities: {} });
        const response = await sendRaw(server, initializeRequest('1999-01-01'));
        if (!isJSONRPCResultResponse(response)) throw new Error('expected result');
        const result = InitializeResultSchema.parse(response.result);
        expect(result.protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
        await server.close();
    });
});
