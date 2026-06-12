/**
 * Connect-time version negotiation: option surface (Q5/Q12), probe mechanics
 * (T9), corrective continuation (T2/A6), typed connect errors, fallback
 * byte-equivalence at the message level, era scope discipline, and the
 * probe-window guard.
 *
 * Wire-real HTTP first-contact shapes (the -32000 literal and the session-
 * required 400) are exercised against real server transports in
 * test/integration/test/client/versionNegotiation.test.ts.
 */
import type { JSONRPCMessage, JSONRPCRequest, Transport } from '@modelcontextprotocol/core';
import {
    isJSONRPCRequest,
    PROTOCOL_VERSION_META_KEY,
    SdkError,
    SdkErrorCode,
    UnsupportedProtocolVersionError
} from '@modelcontextprotocol/core';
import { describe, expect, test } from 'vitest';

import { Client } from '../../src/client/client.js';
import type { StreamableHTTPClientTransportOptions } from '../../src/client/streamableHttp.js';
import type { StdioServerParameters } from '../../src/client/stdio.js';
import { resolveVersionNegotiation } from '../../src/client/versionNegotiation.js';

const MODERN = '2026-07-28';

/* ------------------------------------------------------------------------- *
 * Q5: option home — dissolved transport/stdio negotiation surfaces stay gone.
 * ------------------------------------------------------------------------- */

describe('option surface (Q5/Q12)', () => {
    test('no Transport.negotiation, no transport/stdio negotiation or probeTimeoutMs options (dissolved surfaces)', () => {
        type NotAKeyOf<T, K extends string> = K extends keyof T ? false : true;
        const transportHasNoNegotiation: NotAKeyOf<Transport, 'negotiation'> = true;
        const httpOptionsHaveNoNegotiation: NotAKeyOf<StreamableHTTPClientTransportOptions, 'negotiation'> = true;
        const stdioHasNoNegotiation: NotAKeyOf<StdioServerParameters, 'negotiation'> = true;
        const stdioHasNoProbeTimeout: NotAKeyOf<StdioServerParameters, 'probeTimeoutMs'> = true;
        expect(transportHasNoNegotiation).toBe(true);
        expect(httpOptionsHaveNoNegotiation).toBe(true);
        expect(stdioHasNoNegotiation).toBe(true);
        expect(stdioHasNoProbeTimeout).toBe(true);
    });

    test('absent versionNegotiation resolves to the legacy arm (today’s default; the deferred default ruling is a one-line flip)', () => {
        expect(resolveVersionNegotiation(undefined, undefined)).toEqual({ kind: 'legacy' });
        expect(resolveVersionNegotiation({}, undefined)).toEqual({ kind: 'legacy' });
        expect(resolveVersionNegotiation({ mode: 'legacy' }, undefined)).toEqual({ kind: 'legacy' });
    });

    test('auto resolves default-agnostically: explicit mode never consults the default', () => {
        const auto = resolveVersionNegotiation({ mode: 'auto' }, undefined);
        expect(auto).toMatchObject({ kind: 'auto', modernVersions: [MODERN], fallbackAvailable: true });
    });

    test('a consumer supportedProtocolVersions list drives the offer and the fallback availability', () => {
        const modernOnly = resolveVersionNegotiation({ mode: 'auto' }, [MODERN]);
        expect(modernOnly).toMatchObject({ kind: 'auto', modernVersions: [MODERN], fallbackAvailable: false });

        const mixed = resolveVersionNegotiation({ mode: 'auto' }, ['2027-01-01', MODERN, '2025-11-25']);
        expect(mixed).toMatchObject({ kind: 'auto', modernVersions: ['2027-01-01', MODERN], fallbackAvailable: true });

        const legacyOnly = resolveVersionNegotiation({ mode: 'auto' }, ['2025-11-25']);
        expect(legacyOnly).toMatchObject({ kind: 'auto', modernVersions: [MODERN], fallbackAvailable: true });
    });

    test('pin requires a modern revision', () => {
        expect(resolveVersionNegotiation({ mode: { pin: MODERN } }, undefined)).toMatchObject({ kind: 'pin', version: MODERN });
        expect(() => resolveVersionNegotiation({ mode: { pin: '2025-11-25' } }, undefined)).toThrow(TypeError);
    });
});

/* ------------------------------------------------------------------------- *
 * Scripted transport for probe mechanics.
 * ------------------------------------------------------------------------- */

type Script = (message: JSONRPCMessage, transport: ScriptedTransport) => void;

class ScriptedTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    sessionId?: string;

    startCalls = 0;
    sent: JSONRPCMessage[] = [];
    setProtocolVersionCalls: string[] = [];

    constructor(private readonly script: Script) {}

    async start(): Promise<void> {
        this.startCalls++;
        if (this.startCalls > 1) {
            throw new Error('ScriptedTransport already started! (double-start)');
        }
    }

    async send(message: JSONRPCMessage): Promise<void> {
        this.sent.push(message);
        const deliver = () => this.script(message, this);
        queueMicrotask(deliver);
    }

    async close(): Promise<void> {
        this.onclose?.();
    }

    setProtocolVersion(version: string): void {
        this.setProtocolVersionCalls.push(version);
    }

    reply(message: JSONRPCMessage): void {
        this.onmessage?.(message);
    }
}

const discoverResult = (supportedVersions: string[]) => ({
    supportedVersions,
    capabilities: {},
    serverInfo: { name: 'scripted-modern-server', version: '1.0.0' }
});

/** A scripted dual-era server: answers server/discover with a DiscoverResult and initialize like a 2025 server. */
function modernServerScript(supportedVersions: string[] = [MODERN]): Script {
    return (message, t) => {
        if (!isJSONRPCRequest(message)) return;
        if (message.method === 'server/discover') {
            t.reply({ jsonrpc: '2.0', id: message.id, result: discoverResult(supportedVersions) });
        }
    };
}

/** A scripted 2025 server: -32601 for unknown methods, a plain initialize result otherwise. */
const legacyServerScript: Script = (message, t) => {
    if (!isJSONRPCRequest(message)) return;
    if (message.method === 'initialize') {
        t.reply({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                protocolVersion: '2025-11-25',
                capabilities: {},
                serverInfo: { name: 'scripted-legacy-server', version: '1.0.0' }
            }
        });
    } else {
        t.reply({ jsonrpc: '2.0', id: message.id, error: { code: -32_601, message: 'Method not found' } });
    }
};

const requests = (sent: JSONRPCMessage[]): JSONRPCRequest[] => sent.filter(isJSONRPCRequest);

/* ------------------------------------------------------------------------- *
 * Probe mechanics (T9) + modern resolution.
 * ------------------------------------------------------------------------- */

describe('auto mode against a modern server', () => {
    test('probe-first with a string id, no initialize, setProtocolVersion exactly once after era resolution', async () => {
        const transport = new ScriptedTransport(modernServerScript());
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        await client.connect(transport);

        const sent = requests(transport.sent);
        expect(sent).toHaveLength(1);
        const probe = sent[0]!;
        // T9: never probe with the first real request; string probe id (no
        // collision with Protocol's numeric ids on shared pipes).
        expect(probe.method).toBe('server/discover');
        expect(typeof probe.id).toBe('string');
        expect(String(probe.id)).toMatch(/^server-discover-probe-/);
        // The probe carries the preferred version in its own _meta envelope.
        const meta = (probe.params as { _meta?: Record<string, unknown> })._meta;
        expect(meta?.[PROTOCOL_VERSION_META_KEY]).toBe(MODERN);

        // No initialize, no notifications/initialized on the modern era.
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
        expect(transport.sent.some(m => 'method' in m && m.method === 'notifications/initialized')).toBe(false);

        // The transport version slot was never mutated during negotiation; it is
        // stamped exactly once, after the era resolved modern.
        expect(transport.setProtocolVersionCalls).toEqual([MODERN]);

        expect(client.getProtocolEra()).toBe('modern');
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        expect(client.getServerVersion()?.name).toBe('scripted-modern-server');

        await client.close();
    });

    test('the probe window hands the started transport to Protocol.connect without a double start', async () => {
        const transport = new ScriptedTransport(modernServerScript());
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);
        // ScriptedTransport.start throws on a second call — reaching here proves
        // the handover absorbed Protocol.connect's unconditional start() exactly once.
        expect(transport.startCalls).toBe(1);
        await client.close();
    });
});

/* ------------------------------------------------------------------------- *
 * Fallback: byte-equivalence at the message level + zero version-slot writes.
 * ------------------------------------------------------------------------- */

describe('auto mode against a legacy server (fallback)', () => {
    test('falls back to initialize on the SAME connection; post-probe traffic is identical to a plain legacy connect', async () => {
        const autoTransport = new ScriptedTransport(legacyServerScript);
        const autoClient = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await autoClient.connect(autoTransport);

        const plainTransport = new ScriptedTransport(legacyServerScript);
        const plainClient = new Client({ name: 'c', version: '0' });
        await plainClient.connect(plainTransport);

        // Diff-asserted fallback hygiene: drop the probe, then the auto client's
        // entire outbound sequence must be byte-identical to the plain legacy
        // client's (same initialize id 0, same body incl. protocolVersion).
        const autoSentAfterProbe = autoTransport.sent.slice(1);
        expect(JSON.stringify(autoSentAfterProbe)).toBe(JSON.stringify(plainTransport.sent));

        // Same setProtocolVersion behavior as the plain path (once, with the
        // initialize-negotiated version) — nothing was set or cleared around the probe.
        expect(autoTransport.setProtocolVersionCalls).toEqual(plainTransport.setProtocolVersionCalls);

        expect(autoClient.getProtocolEra()).toBe('legacy');
        expect(plainClient.getProtocolEra()).toBe('legacy');

        await autoClient.close();
        await plainClient.close();
    });

    test('option-parameterized oracle: a custom supportedProtocolVersions list flows into the fallback initialize body', async () => {
        const versions = ['2025-06-18', '2025-03-26'];
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'initialize') {
                t.reply({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's', version: '1' } }
                });
            } else {
                t.reply({ jsonrpc: '2.0', id: message.id, error: { code: -32_601, message: 'Method not found' } });
            }
        };

        const autoTransport = new ScriptedTransport(script);
        const autoClient = new Client(
            { name: 'c', version: '0' },
            { versionNegotiation: { mode: 'auto' }, supportedProtocolVersions: versions }
        );
        await autoClient.connect(autoTransport);

        const plainTransport = new ScriptedTransport(script);
        const plainClient = new Client({ name: 'c', version: '0' }, { supportedProtocolVersions: versions });
        await plainClient.connect(plainTransport);

        expect(JSON.stringify(autoTransport.sent.slice(1))).toBe(JSON.stringify(plainTransport.sent));
        const init = requests(autoTransport.sent)[1]!;
        expect((init.params as { protocolVersion?: string }).protocolVersion).toBe('2025-06-18');

        await autoClient.close();
        await plainClient.close();
    });

    // Fallback against REAL servers (in-memory pair, stateful HTTP, stateless
    // HTTP — both first-contact wire shapes) is covered in
    // test/integration/test/client/versionNegotiation.test.ts.
});

/* ------------------------------------------------------------------------- *
 * Q12: timeout & retries are typed connect errors, never era verdicts.
 * ------------------------------------------------------------------------- */

describe('probe timeout policy (Q12)', () => {
    const silentScript: Script = () => {
        /* never replies */
    };

    test('timeout rejects with the standard typed timeout error and is NEVER converted to a legacy verdict', async () => {
        const transport = new ScriptedTransport(silentScript);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 50 } } });

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout
        );

        // Never a legacy verdict: no initialize was attempted, before or after the timeout.
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
        expect(requests(transport.sent)).toHaveLength(1);
        expect(transport.setProtocolVersionCalls).toEqual([]);
    });

    test('maxRetries governs timeout re-sends only (default 0); each re-send uses a fresh probe id', async () => {
        const transport = new ScriptedTransport(silentScript);
        const client = new Client(
            { name: 'c', version: '0' },
            { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 30, maxRetries: 2 } } }
        );

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout
        );

        const probes = requests(transport.sent);
        expect(probes).toHaveLength(3); // initial + 2 re-sends
        const ids = probes.map(p => String(p.id));
        expect(new Set(ids).size).toBe(3);
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });
});

/* ------------------------------------------------------------------------- *
 * T2/A6: -32004 corrective continuation — exactly once; loop guard on second
 * rejection. Not counted against probe.maxRetries (Q12 disambiguation).
 * ------------------------------------------------------------------------- */

describe('-32004 corrective continuation (T2/A6)', () => {
    test('select-and-continue runs exactly once, even when the mutual version equals the just-rejected one', async () => {
        let discoverCalls = 0;
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                discoverCalls++;
                if (discoverCalls === 1) {
                    // Buggy-but-modern server: rejects the version it itself lists.
                    t.reply({
                        jsonrpc: '2.0',
                        id: message.id,
                        error: {
                            code: -32_004,
                            message: 'Unsupported protocol version',
                            data: { supported: [MODERN], requested: MODERN }
                        }
                    });
                } else {
                    t.reply({ jsonrpc: '2.0', id: message.id, result: discoverResult([MODERN]) });
                }
            }
        };

        const transport = new ScriptedTransport(script);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto', probe: { maxRetries: 0 } } });
        await client.connect(transport);

        // The corrective continuation is spec-mandated and NOT counted against
        // maxRetries (0 here): the second probe still happened.
        expect(discoverCalls).toBe(2);
        expect(client.getProtocolEra()).toBe('modern');
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);

        // MUST NOT fall back at any point.
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);

        await client.close();
    });

    test('the loop guard arms on the second rejection: typed error, never an infinite continuation', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            t.reply({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32_004, message: 'Unsupported protocol version', data: { supported: [MODERN], requested: MODERN } }
            });
        };

        const transport = new ScriptedTransport(script);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        await expect(client.connect(transport)).rejects.toBeInstanceOf(UnsupportedProtocolVersionError);
        expect(requests(transport.sent)).toHaveLength(2);
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });

    test('-32004 with a disjoint-but-modern list: typed error, never initialize', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            t.reply({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32_004, message: 'Unsupported protocol version', data: { supported: ['2027-12-31'] } }
            });
        };

        const transport = new ScriptedTransport(script);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        await expect(client.connect(transport)).rejects.toBeInstanceOf(UnsupportedProtocolVersionError);
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });

    test('-32004 with a legacy-only list: definitive legacy signal, initialize on the same connection', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                t.reply({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32_004, message: 'Unsupported protocol version', data: { supported: ['2025-11-25'] } }
                });
            } else {
                legacyServerScript(message, t);
            }
        };

        const transport = new ScriptedTransport(script);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);

        expect(client.getProtocolEra()).toBe('legacy');
        await client.close();
    });

    test('modern-only client + legacy-only -32004 list: typed error carrying data.supported', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            t.reply({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32_004, message: 'Unsupported protocol version', data: { supported: ['2025-11-25'] } }
            });
        };

        const transport = new ScriptedTransport(script);
        const client = new Client(
            { name: 'c', version: '0' },
            { versionNegotiation: { mode: 'auto' }, supportedProtocolVersions: [MODERN] }
        );

        const rejection = await client.connect(transport).then(
            () => undefined,
            error => error as UnsupportedProtocolVersionError
        );
        expect(rejection).toBeInstanceOf(UnsupportedProtocolVersionError);
        expect(rejection!.supported).toEqual(['2025-11-25']);
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });
});

/* ------------------------------------------------------------------------- *
 * Pin mode: no fallback, loud failure.
 * ------------------------------------------------------------------------- */

describe('pin mode', () => {
    test('modern era at the pinned version when the server offers it', async () => {
        const transport = new ScriptedTransport(modernServerScript([MODERN, '2027-01-01']));
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await client.connect(transport);

        expect(client.getProtocolEra()).toBe('modern');
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        await client.close();
    });

    test('a legacy server fails loudly — no initialize fallback', async () => {
        const transport = new ScriptedTransport(legacyServerScript);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: MODERN } } });

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed
        );
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });

    test('a modern server without the pinned version fails with typed data — never initialize', async () => {
        const transport = new ScriptedTransport(modernServerScript(['2027-12-31']));
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: MODERN } } });

        const rejection = await client.connect(transport).then(
            () => undefined,
            error => error as UnsupportedProtocolVersionError
        );
        expect(rejection).toBeInstanceOf(UnsupportedProtocolVersionError);
        expect(rejection!.supported).toEqual(['2027-12-31']);
        expect(rejection!.requested).toBe(MODERN);
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });
});

/* ------------------------------------------------------------------------- *
 * Probe-window guard: pre-init server→client traffic mid-probe is dropped
 * with zero bytes.
 * ------------------------------------------------------------------------- */

describe('probe-window guard', () => {
    test('a 2025-legal pre-init server→client request arriving mid-probe is dropped with zero bytes', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                // The server pushes a ping BEFORE answering the probe (legal on a
                // 2025 stdio pipe). It must be dropped — no response bytes.
                t.reply({ jsonrpc: '2.0', id: 999, method: 'ping' });
                t.reply({ jsonrpc: '2.0', id: message.id, error: { code: -32_601, message: 'Method not found' } });
            } else {
                legacyServerScript(message, t);
            }
        };

        const transport = new ScriptedTransport(script);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);

        // Zero bytes for the dropped request: nothing in the sent log answers id 999.
        const repliesTo999 = transport.sent.filter(m => 'id' in m && m.id === 999);
        expect(repliesTo999).toEqual([]);
        expect(client.getProtocolEra()).toBe('legacy');
        await client.close();
    });
});

/* ------------------------------------------------------------------------- *
 * Scope discipline: era is connection state — re-negotiated on every fresh
 * connect, never silently demoted on the current connection.
 * ------------------------------------------------------------------------- */

describe('era scope discipline', () => {
    test('every fresh auto connect re-runs negotiation: no verdict survives a reconnect', async () => {
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        // First connect: probe, then fallback.
        const first = new ScriptedTransport(legacyServerScript);
        await client.connect(first);
        expect(requests(first.sent)[0]!.method).toBe('server/discover');
        expect(client.getProtocolEra()).toBe('legacy');
        await client.close();

        // Second (fresh) connect: the negotiated protocol version is connection
        // state and is cleared at fresh connect — the probe runs again instead
        // of replaying the previous connection's verdict.
        const second = new ScriptedTransport(legacyServerScript);
        await client.connect(second);
        expect(requests(second.sent)[0]!.method).toBe('server/discover');
        expect(client.getProtocolEra()).toBe('legacy');
        await client.close();
    });

    test('an established modern era is never silently demoted: later failures surface, only the NEXT connect re-negotiates', async () => {
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        const transport = new ScriptedTransport(modernServerScript());
        await client.connect(transport);
        expect(client.getProtocolEra()).toBe('modern');

        // A later transport failure does not demote the current connection's era
        // and triggers no initialize.
        transport.onerror?.(new Error('boom'));
        expect(client.getProtocolEra()).toBe('modern');
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
        await client.close();

        // The next connect re-runs negotiation (the discover exchange doubles as
        // the capability fetch).
        const next = new ScriptedTransport(modernServerScript());
        await client.connect(next);
        expect(requests(next.sent)[0]!.method).toBe('server/discover');
        expect(client.getProtocolEra()).toBe('modern');
        await client.close();
    });

    test('no era state exists before the first connect, and none is persisted anywhere', () => {
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        expect(client.getProtocolEra()).toBeUndefined();
        // No cachedEra option surface (deferred-additive).
        type NotAKeyOf<T, K extends string> = K extends keyof T ? false : true;
        const noCachedEra: NotAKeyOf<NonNullable<ConstructorParameters<typeof Client>[1]>, 'cachedEra'> = true;
        expect(noCachedEra).toBe(true);
    });
});
