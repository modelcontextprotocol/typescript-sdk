// #2619: the real StreamableHTTPClientTransport against a fetch stub that plays a gateway in front of a 2025 server.
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import { Client } from '../../src/client/client';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp';

const JSON_CT = { 'content-type': 'application/json' };
const UNUSABLE = 'the server answered with an unusable reply';

function gatewayInFrontOfLegacy(probeAnswer: () => Response | Promise<Response>) {
    const seen: string[] = [];
    const fetchStub = async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
        if (init?.method !== 'POST') return new Response(null, { status: 405 });
        const message = JSON.parse(String(init.body)) as { id?: unknown; method?: string };
        seen.push(message.method ?? '(response)');
        if (message.method === 'server/discover') return probeAnswer();
        if (message.method === 'initialize') {
            return Response.json(
                {
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: '2025-11-25',
                        capabilities: {},
                        serverInfo: { name: 'legacy-behind-gateway', version: '1.0.0' }
                    }
                },
                { status: 200, headers: JSON_CT }
            );
        }
        return new Response(null, { status: 202 });
    };
    return { fetchStub: fetchStub as typeof fetch, seen };
}

async function connect(
    options: ConstructorParameters<typeof Client>[1],
    probeAnswer: () => Response | Promise<Response>,
    connectOptions?: Parameters<Client['connect']>[1]
) {
    const { fetchStub, seen } = gatewayInFrontOfLegacy(probeAnswer);
    const client = new Client({ name: 'repro-2619', version: '1.0.0' }, options);
    const transport = new StreamableHTTPClientTransport(new URL('http://gateway.invalid/mcp'), { fetch: fetchStub });
    const outcome = await client.connect(transport, connectOptions).then(
        () => 'connected' as const,
        (error: unknown) => error
    );
    const era = outcome === 'connected' ? client.getProtocolEra() : undefined;
    const server = outcome === 'connected' ? client.getServerVersion()?.name : undefined;
    await client.close().catch(() => {});
    return { outcome, era, server, seen };
}

const AUTO = { versionNegotiation: { mode: 'auto' as const } };
const emptyJson = () => new Response('', { status: 200, headers: JSON_CT });

describe('#2619: the four rows of the issue table (real transport, injected fetch)', () => {
    const rows: Array<[string, () => Response, string]> = [
        ['200, application/json, empty body', emptyJson, 'SyntaxError'],
        ['200, application/json, whitespace body', () => new Response('  \n', { status: 200, headers: JSON_CT }), 'SyntaxError'],
        ['204, no content-type', () => new Response(null, { status: 204 }), 'SdkError'],
        ['200, text/plain', () => new Response('OK', { status: 200, headers: { 'content-type': 'text/plain' } }), 'SdkError']
    ];

    test.each(rows)('%s -> connect() rejects, says what was answered, and never sends initialize', async (_label, probeAnswer, cause) => {
        const { outcome, seen } = await connect(AUTO, probeAnswer);
        expect(outcome).toBeInstanceOf(SdkError);
        expect((outcome as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((outcome as SdkError).message).toContain(UNUSABLE);
        expect(((outcome as Error).cause as Error | undefined)?.name).toBe(cause);
        expect(seen).toEqual(['server/discover']);
    });
});

describe('#2619: the way out the message points to', () => {
    test('a known-legacy verdict skips the probe and connects', async () => {
        const { outcome, era, server, seen } = await connect(AUTO, emptyJson, { prior: { kind: 'legacy' } });
        expect(outcome).toBe('connected');
        expect(era).toBe('legacy');
        expect(server).toBe('legacy-behind-gateway');
        expect(seen.slice(0, 2)).toEqual(['initialize', 'notifications/initialized']);
    });

    test('the default mode sends no probe and connects', async () => {
        const { outcome, era, seen } = await connect(undefined, emptyJson);
        expect(outcome).toBe('connected');
        expect(era).toBe('legacy');
        expect(seen).not.toContain('server/discover');
    });
});

describe('#2619: what must not move', () => {
    test('control from the issue: a 400 with an unrecognized body already falls back', async () => {
        const { outcome, era } = await connect(AUTO, () => new Response('Bad Request', { status: 400 }));
        expect(outcome).toBe('connected');
        expect(era).toBe('legacy');
    });

    test('a network failure on the probe keeps its own message, and initialize is never sent', async () => {
        const { outcome, seen } = await connect(AUTO, () => Promise.reject(new TypeError('fetch failed')));
        expect(outcome).toBeInstanceOf(SdkError);
        expect((outcome as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((outcome as SdkError).message).not.toContain(UNUSABLE);
        expect(seen).toEqual(['server/discover']);
    });

    test('pin mode on an empty 200 rejects with the same message and keeps Error.cause', async () => {
        const { outcome, seen } = await connect({ versionNegotiation: { mode: { pin: '2026-07-28' } } }, emptyJson);
        expect(outcome).toBeInstanceOf(SdkError);
        expect((outcome as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((outcome as SdkError).message).toContain(UNUSABLE);
        expect(((outcome as Error).cause as Error | undefined)?.name).toBe('SyntaxError');
        expect(seen).toEqual(['server/discover']);
    });

    test('a modern-only client on an empty 200 rejects with the same message and keeps Error.cause', async () => {
        const { outcome, seen } = await connect(
            { versionNegotiation: { mode: 'auto' }, supportedProtocolVersions: ['2026-07-28'] },
            emptyJson
        );
        expect(outcome).toBeInstanceOf(SdkError);
        expect((outcome as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((outcome as SdkError).message).toContain(UNUSABLE);
        expect(((outcome as Error).cause as Error | undefined)?.name).toBe('SyntaxError');
        expect(seen).toEqual(['server/discover']);
    });

    test('a 401 on the probe stays an auth failure', async () => {
        const { outcome, seen } = await connect(AUTO, () => new Response('Unauthorized', { status: 401 }));
        expect(outcome).toBeInstanceOf(SdkError);
        expect((outcome as SdkError).code).toBe(SdkErrorCode.ClientHttpAuthentication);
        expect(seen).toEqual(['server/discover']);
    });
});

describe('#2619: when every request is answered the same way', () => {
    test('connect() rejects after exactly one request, typed', async () => {
        const seen: string[] = [];
        const fetchStub = (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            seen.push((JSON.parse(String(init?.body)) as { method?: string }).method ?? '(response)');
            return new Response('<html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
        }) as typeof fetch;
        const client = new Client({ name: 'repro-2619', version: '1.0.0' }, AUTO);
        const transport = new StreamableHTTPClientTransport(new URL('http://gateway.invalid/mcp'), { fetch: fetchStub });
        const outcome = await client.connect(transport).then(
            () => 'connected' as const,
            (error: unknown) => error
        );
        await client.close().catch(() => {});
        expect(outcome).toBeInstanceOf(SdkError);
        expect((outcome as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((outcome as SdkError).message).toContain(UNUSABLE);
        expect(seen).toEqual(['server/discover']);
    });
});
