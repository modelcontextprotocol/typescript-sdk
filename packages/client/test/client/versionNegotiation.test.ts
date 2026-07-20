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
import type { JSONRPCMessage, JSONRPCRequest, Transport } from '@modelcontextprotocol/core-internal';
import {
    isJSONRPCRequest,
    PROTOCOL_VERSION_META_KEY,
    SdkError,
    SdkErrorCode,
    UnsupportedProtocolVersionError
} from '@modelcontextprotocol/core-internal';
import { describe, expect, test } from 'vitest';

import { UnauthorizedError } from '../../src/client/auth';
import { Client } from '../../src/client/client';
import type { StreamableHTTPClientTransportOptions } from '../../src/client/streamableHttp';
import type { StdioServerParameters } from '../../src/client/stdio';
import { resolveVersionNegotiation } from '../../src/client/versionNegotiation';

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
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'scripted-modern-server', version: '1.0.0' } }
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

        expect(autoClient.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        expect(plainClient.getNegotiatedProtocolVersion()).toBe('2025-11-25');

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

    test('a dual-era supportedProtocolVersions list never leaks a 2026 version into the fallback initialize', async () => {
        const transport = new ScriptedTransport(legacyServerScript);
        const client = new Client(
            { name: 'c', version: '0' },
            { versionNegotiation: { mode: 'auto' }, supportedProtocolVersions: [MODERN, '2025-11-25'] }
        );
        await client.connect(transport);

        // The fallback initialize offers the first LEGACY version of the list,
        // never the 2026-era entry.
        const init = requests(transport.sent).find(r => r.method === 'initialize')!;
        expect((init.params as { protocolVersion?: string }).protocolVersion).toBe('2025-11-25');
        expect(JSON.stringify(transport.sent.slice(1))).not.toContain(MODERN);
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');

        await client.close();
    });

    test('a non-conforming server that echoes a 2026 revision from initialize is rejected by the accept check', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'initialize') {
                t.reply({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: { protocolVersion: MODERN, capabilities: {}, serverInfo: { name: 's', version: '1' } }
                });
            } else {
                t.reply({ jsonrpc: '2.0', id: message.id, error: { code: -32_601, message: 'Method not found' } });
            }
        };

        const transport = new ScriptedTransport(script);
        const client = new Client(
            { name: 'c', version: '0' },
            { versionNegotiation: { mode: 'auto' }, supportedProtocolVersions: [MODERN, '2025-11-25'] }
        );

        await expect(client.connect(transport)).rejects.toThrow(/protocol version is not supported/);
    });

    test('a modern-only client in auto mode gets a typed error instead of a fallback when the server gives no modern evidence', async () => {
        const transport = new ScriptedTransport(legacyServerScript);
        const client = new Client(
            { name: 'c', version: '0' },
            { versionNegotiation: { mode: 'auto' }, supportedProtocolVersions: [MODERN] }
        );

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed
        );
        // The fallback never ran: no initialize carrying any version was sent.
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });

    // Fallback against REAL servers (in-memory pair, stateful HTTP, stateless
    // HTTP — both first-contact wire shapes) is covered in
    // test/integration/test/client/versionNegotiation.test.ts.
});

/* ------------------------------------------------------------------------- *
 * Probe timeout policy: transport-aware. On HTTP-class transports a timeout
 * is a typed connect error (silence on a deployed server is an outage); on
 * stdio it is a legacy-server signal and falls back to initialize on the same
 * stream (the stdio transport's backward-compatibility rule — some legacy
 * servers do not respond to unknown pre-initialize requests at all).
 * ------------------------------------------------------------------------- */

describe('probe timeout policy (transport-aware)', () => {
    const silentScript: Script = () => {
        /* never replies */
    };

    test('HTTP-class transport: timeout rejects with the standard typed timeout error and is never converted to a legacy verdict', async () => {
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

    /** A stdio-shaped transport: structurally recognizable by its stderr/pid accessors. */
    class StdioShapedTransport extends ScriptedTransport {
        get stderr(): null {
            return null;
        }
        get pid(): number {
            return 4242;
        }
    }

    test('stdio-class transport: a server that never answers the probe is a legacy server — initialize fallback on the same stream', async () => {
        // A silent legacy stdio server: ignores the unknown server/discover
        // request entirely, but answers initialize like any 2025 server.
        const silentLegacyScript: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'initialize') {
                legacyServerScript(message, t);
            }
            // Anything else (the probe) is ignored — no reply at all.
        };

        const transport = new StdioShapedTransport(silentLegacyScript);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 30 } } });

        await client.connect(transport);

        // The timeout resolved to the legacy verdict and the initialize fallback
        // ran on the SAME transport.
        const sent = requests(transport.sent);
        expect(sent.filter(r => r.method === 'server/discover')).toHaveLength(1);
        expect(sent.some(r => r.method === 'initialize')).toBe(true);
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');

        await client.close();
    });

    test('stdio-class transport: pin mode still fails loudly on a silent server (no fallback)', async () => {
        const transport = new StdioShapedTransport(() => {
            /* never replies */
        });
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: MODERN }, probe: { timeoutMs: 30 } } });

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed
        );
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });

    test('maxRetries (default 0) governs timeout re-sends only; the timeout verdict applies after retries are exhausted', async () => {
        // HTTP-class: even with retries, a server that never answers produces a
        // typed timeout error after maxRetries+1 probe sends — never a legacy verdict.
        const transport = new ScriptedTransport(silentScript);
        const client = new Client(
            { name: 'c', version: '0' },
            { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 20, maxRetries: 2 } } }
        );

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout
        );
        const probes = transport.sent.filter(m => 'method' in m && m.method === 'server/discover');
        expect(probes).toHaveLength(3);
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });

    test('maxRetries: a server that answers on the first retry resolves normally (the retry budget is timeout-only)', async () => {
        let discoverCalls = 0;
        const slowThenFastScript: Script = (message, t) => {
            if (!isJSONRPCRequest(message) || message.method !== 'server/discover') return;
            discoverCalls++;
            // Ignore the first probe (forces a timeout); answer the retry.
            if (discoverCalls === 1) return;
            t.reply({ jsonrpc: '2.0', id: message.id, result: discoverResult([MODERN]) });
        };
        const transport = new ScriptedTransport(slowThenFastScript);
        const client = new Client(
            { name: 'c', version: '0' },
            { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 20, maxRetries: 1 } } }
        );

        await client.connect(transport);
        expect(discoverCalls).toBe(2);
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        await client.close();
    });
});

/* ------------------------------------------------------------------------- *
 * Probe close policy. The SDK's stdio transport probes on a DISPOSABLE
 * SIBLING spawned from the same `_serverParams` — servers built on SDKs that
 * terminate on any pre-initialize request (the official Rust SDK, rmcp) exit
 * when the probe arrives, so the probe must not spend the caller's one child
 * life. The session transport starts exactly once, after the era is known.
 * Stdio-shaped transports without readable params probe in place, where a
 * mid-probe close stays a typed error; HTTP closes stay typed errors.
 * ------------------------------------------------------------------------- */

describe('stdio sibling probe (disposable probe transport)', () => {
    /**
     * An SDK-shaped stdio transport: retains `_serverParams` (the sibling
     * seam), and scripts its "child" from `params.behavior` — 'rmcp' exits on
     * any pre-initialize request, 'modern' answers server/discover, 'silent'
     * never replies. Mirrors StdioClientTransport's surface, including the
     * internal `_dispose` reaper (recorded, for the leak pins).
     */
    class FakeStdioTransport implements Transport {
        static instances: FakeStdioTransport[] = [];
        onclose?: () => void;
        onerror?: (error: Error) => void;
        onmessage?: (message: JSONRPCMessage) => void;
        sessionId?: string;

        readonly _serverParams: Record<string, unknown>;
        startCalls = 0;
        sent: JSONRPCMessage[] = [];
        setProtocolVersionCalls: string[] = [];
        disposed = false;
        private _alive = false;
        private _initialized = false;

        constructor(params: Record<string, unknown>) {
            this._serverParams = params;
            FakeStdioTransport.instances.push(this);
        }

        get stderr(): null {
            return null;
        }
        get pid(): number | null {
            return this._alive ? 100 + FakeStdioTransport.instances.indexOf(this) : null;
        }

        async start(): Promise<void> {
            if (this._alive) throw new Error('FakeStdioTransport already started!');
            if (this._serverParams.behavior === 'spawnfail') throw new Error('spawn ENOENT');
            this._alive = true;
            this._initialized = false;
            this.startCalls++;
        }

        async send(message: JSONRPCMessage): Promise<void> {
            if (!this._alive) throw new Error('Not connected');
            this.sent.push(message);
            queueMicrotask(() => {
                if (!this._alive || !isJSONRPCRequest(message)) return;
                if (message.method === 'initialize') {
                    this._initialized = true;
                    this.onmessage?.({
                        jsonrpc: '2.0',
                        id: message.id,
                        result: {
                            protocolVersion: '2025-03-26',
                            capabilities: {},
                            serverInfo: { name: 'fake-stdio-server', version: '1.0.0' }
                        }
                    });
                } else if (message.method === 'server/discover' && this._serverParams.behavior === 'modern') {
                    this.onmessage?.({ jsonrpc: '2.0', id: message.id, result: discoverResult([MODERN]) });
                } else if (!this._initialized && this._serverParams.behavior === 'rmcp') {
                    // The rmcp shape: any other pre-initialize request kills the
                    // child — no reply, just the close.
                    this._alive = false;
                    this.onclose?.();
                }
                // 'silent': no reply at all.
            });
        }

        async close(): Promise<void> {
            if (this._alive) {
                this._alive = false;
                this.onclose?.();
            }
        }

        /** Test hook: observe the moment disposal begins (reset after use). */
        static onDisposeStart: (() => void) | undefined;

        // Called structurally by the sibling reaper, like the real transport's.
        private async _dispose(): Promise<void> {
            FakeStdioTransport.onDisposeStart?.();
            this.disposed = true;
            this._alive = false;
        }

        setProtocolVersion(version: string): void {
            this.setProtocolVersionCalls.push(version);
        }
    }

    const freshInstances = () => {
        FakeStdioTransport.instances = [];
    };

    test('rmcp exit-on-probe: the sibling spends itself, the session connects legacy on its first and only spawn', async () => {
        freshInstances();
        const session = new FakeStdioTransport({ command: 'srv', behavior: 'rmcp' });
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        await client.connect(session);

        expect(FakeStdioTransport.instances).toHaveLength(2);
        const sibling = FakeStdioTransport.instances[1]!;
        // The sibling carries the same params with stderr discarded, took the
        // probe (and only the probe), and was reaped.
        expect(sibling._serverParams).toMatchObject({ command: 'srv', stderr: 'ignore' });
        expect(requests(sibling.sent).map(r => r.method)).toEqual(['server/discover']);
        expect(sibling.disposed).toBe(true);
        // The session transport: one spawn, no probe bytes, plain legacy connect.
        expect(session.startCalls).toBe(1);
        expect(requests(session.sent).map(r => r.method)).toEqual(['initialize']);
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-03-26');
        expect(session.setProtocolVersionCalls).toEqual(['2025-03-26']);

        await client.close();
    });

    test("the session's traffic is byte-identical to a plain mode:'legacy' connect", async () => {
        freshInstances();
        const autoSession = new FakeStdioTransport({ command: 'srv', behavior: 'rmcp' });
        const autoClient = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await autoClient.connect(autoSession);

        const plainSession = new FakeStdioTransport({ command: 'srv', behavior: 'rmcp' });
        const plainClient = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'legacy' } });
        await plainClient.connect(plainSession);

        expect(JSON.stringify(autoSession.sent)).toBe(JSON.stringify(plainSession.sent));
        // Explicit legacy mode never probes and never spawns a sibling.
        expect(FakeStdioTransport.instances).toHaveLength(3);
        expect(plainSession.startCalls).toBe(1);

        await autoClient.close();
        await plainClient.close();
    });

    test('modern server: the verdict is adopted verbatim — the session wire carries NO server/discover and no initialize', async () => {
        freshInstances();
        const session = new FakeStdioTransport({ command: 'srv', behavior: 'modern' });
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        await client.connect(session);

        expect(FakeStdioTransport.instances).toHaveLength(2);
        expect(FakeStdioTransport.instances[1]!.disposed).toBe(true);
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        expect(client.getServerVersion()?.name).toBe('scripted-modern-server');
        expect(session.startCalls).toBe(1);
        // Byte-trace: the sibling probed; the session sent nothing at connect.
        expect(requests(session.sent)).toHaveLength(0);
        expect(session.setProtocolVersionCalls).toEqual([MODERN]);

        await client.close();
    });

    test('caller close() mid-probe aborts promptly: typed error, the session transport is never started', async () => {
        freshInstances();
        const session = new FakeStdioTransport({ command: 'srv', behavior: 'silent' });
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 30_000 } } });

        const pending = client.connect(session);
        pending.catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 0));
        await session.close();

        const rejection = await pending.then(
            () => undefined,
            (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((rejection as SdkError).message).toMatch(/transport was closed during the server\/discover probe/);
        expect(session.startCalls).toBe(0);
        expect(FakeStdioTransport.instances[1]!.disposed).toBe(true);
        // The wrapper restored the caller's close by identity.
        expect(session.close).toBe(FakeStdioTransport.prototype.close);
    });

    test('pin mode: exit-on-probe rejects naming the close — session never started', async () => {
        freshInstances();
        const session = new FakeStdioTransport({ command: 'srv', behavior: 'rmcp' });
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: MODERN } } });

        const rejection = await client.connect(session).then(
            () => undefined,
            (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((rejection as SdkError).message).toMatch(
            /connection closed during the server\/discover probe before the server offered pinned/
        );
        expect(session.startCalls).toBe(0);
        expect(FakeStdioTransport.instances[1]!.disposed).toBe(true);
    });

    test('modern-only client: exit-on-probe rejects naming the close — session never started', async () => {
        freshInstances();
        const session = new FakeStdioTransport({ command: 'srv', behavior: 'rmcp' });
        const client = new Client(
            { name: 'c', version: '0' },
            { versionNegotiation: { mode: 'auto' }, supportedProtocolVersions: [MODERN] }
        );

        const rejection = await client.connect(session).then(
            () => undefined,
            (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((rejection as SdkError).message).toMatch(/connection closed during the server\/discover probe and this client supports no/);
        expect(session.startCalls).toBe(0);
    });

    test('a sibling that cannot spawn propagates the raw spawn error (the session would fail identically)', async () => {
        freshInstances();
        const session = new FakeStdioTransport({ command: 'missing', behavior: 'spawnfail' });
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        await expect(client.connect(session)).rejects.toThrow(/spawn ENOENT/);
        expect(session.startCalls).toBe(0);
    });

    test('a SUBCLASS of the SDK stdio transport probes in place: typed error naming the base-class requirement, no sibling spawned', async () => {
        // A subclass cannot be faithfully cloned by re-invoking its constructor
        // with the retained params alone — the gate is exact-class (only the
        // base prototype owns the internal reaper), so subclasses keep the
        // in-place behavior.
        freshInstances();
        class SubclassedStdioTransport extends FakeStdioTransport {}
        const transport = new SubclassedStdioTransport({ command: 'srv', behavior: 'rmcp' });
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        const rejection = await client.connect(transport).then(
            () => undefined,
            (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((rejection as SdkError).message).toMatch(/sibling probe requires the SDK's base StdioClientTransport/);
        // No sibling was constructed: the only instance is the caller's own,
        // and it took the probe itself (in place).
        expect(FakeStdioTransport.instances).toHaveLength(1);
        expect(requests(transport.sent).map(r => r.method)).toEqual(['server/discover']);
    });

    test('a caller close() landing during sibling DISPOSAL still aborts: the session transport is never started', async () => {
        // The close watch stays armed through disposal (the finally disposes
        // BEFORE restoring close, and the abort is re-checked after it), so a
        // shutdown racing the reap cannot be followed by a session spawn.
        freshInstances();
        const session = new FakeStdioTransport({ command: 'srv', behavior: 'modern' });
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        let closedDuringDisposal = false;
        FakeStdioTransport.onDisposeStart = () => {
            if (!closedDuringDisposal) {
                closedDuringDisposal = true;
                void session.close();
            }
        };
        try {
            const rejection = await client.connect(session).then(
                () => undefined,
                (error: unknown) => error
            );
            expect(closedDuringDisposal).toBe(true);
            expect(rejection).toBeInstanceOf(SdkError);
            expect((rejection as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
            expect((rejection as SdkError).message).toMatch(/transport was closed during the server\/discover probe/);
            expect(session.startCalls).toBe(0);
        } finally {
            FakeStdioTransport.onDisposeStart = undefined;
        }
    });

    test('a stdio-shaped transport WITHOUT readable spawn params probes in place: a mid-probe close stays a typed error', async () => {
        // Foreign transports have no sibling seam — exactly main's behavior.
        class ForeignStdioTransport extends ScriptedTransport {
            get stderr(): null {
                return null;
            }
            get pid(): number {
                return 4242;
            }
        }
        const transport = new ForeignStdioTransport((message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                t.onclose?.();
            }
        });
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        const rejection = await client.connect(transport).then(
            () => undefined,
            (error: unknown) => error
        );
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect((rejection as SdkError).message).toMatch(/connection closed during the server\/discover probe/);
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });

    test('HTTP-class transport: close mid-probe rejects like any probe transport failure — never a legacy verdict, never a sibling', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                t.onclose?.();
                return;
            }
            legacyServerScript(message, t);
        };
        const transport = new ScriptedTransport(script);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed
        );
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
        expect(transport.startCalls).toBe(1);
    });
});

/* ------------------------------------------------------------------------- *
 * -32022 corrective continuation — exactly once; loop guard on second
 * rejection.
 * ------------------------------------------------------------------------- */

describe('-32022 corrective continuation', () => {
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
                            code: -32_022,
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
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);

        // The corrective continuation is spec-mandated: the second probe still happened.
        expect(discoverCalls).toBe(2);
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
                error: { code: -32_022, message: 'Unsupported protocol version', data: { supported: [MODERN], requested: MODERN } }
            });
        };

        const transport = new ScriptedTransport(script);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        await expect(client.connect(transport)).rejects.toBeInstanceOf(UnsupportedProtocolVersionError);
        expect(requests(transport.sent)).toHaveLength(2);
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });

    test('-32022 with a disjoint-but-modern list: typed error, never initialize', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            t.reply({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32_022, message: 'Unsupported protocol version', data: { supported: ['2027-12-31'] } }
            });
        };

        const transport = new ScriptedTransport(script);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        await expect(client.connect(transport)).rejects.toBeInstanceOf(UnsupportedProtocolVersionError);
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
    });

    test('-32022 with a legacy-only list: definitive legacy signal, initialize on the same connection', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                t.reply({
                    jsonrpc: '2.0',
                    id: message.id,
                    error: { code: -32_022, message: 'Unsupported protocol version', data: { supported: ['2025-11-25'] } }
                });
            } else {
                legacyServerScript(message, t);
            }
        };

        const transport = new ScriptedTransport(script);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);

        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        await client.close();
    });

    test('modern-only client + legacy-only -32022 list: typed error carrying data.supported', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            t.reply({
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32_022, message: 'Unsupported protocol version', data: { supported: ['2025-11-25'] } }
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

    test('a failed negotiation leaves the transport start() untouched (no armed pass-through)', async () => {
        const transport = new ScriptedTransport(legacyServerScript);
        const originalStart = transport.start;
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: MODERN } } });

        await expect(client.connect(transport)).rejects.toSatisfy(
            error => error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed
        );

        // The probe window's one-shot start() pass-through must not stay armed
        // on a transport the caller still owns after a failed connect.
        expect(transport.start).toBe(originalStart);
        expect(transport.onmessage).toBeUndefined();
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
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
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
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        await client.close();

        // Second (fresh) connect: the negotiated protocol version is connection
        // state and is cleared at fresh connect — the probe runs again instead
        // of replaying the previous connection's verdict.
        const second = new ScriptedTransport(legacyServerScript);
        await client.connect(second);
        expect(requests(second.sent)[0]!.method).toBe('server/discover');
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        await client.close();
    });

    test('an established modern era is never silently demoted: later failures surface, only the NEXT connect re-negotiates', async () => {
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        const transport = new ScriptedTransport(modernServerScript());
        await client.connect(transport);
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);

        // A later transport failure does not demote the current connection's era
        // and triggers no initialize.
        transport.onerror?.(new Error('boom'));
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        expect(transport.sent.some(m => 'method' in m && m.method === 'initialize')).toBe(false);
        await client.close();

        // The next connect re-runs negotiation (the discover exchange doubles as
        // the capability fetch).
        const next = new ScriptedTransport(modernServerScript());
        await client.connect(next);
        expect(requests(next.sent)[0]!.method).toBe('server/discover');
        expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
        await client.close();
    });

    test('no era state exists before the first connect, and none is persisted anywhere', () => {
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        expect(client.getNegotiatedProtocolVersion()).toBeUndefined();
        // No cachedEra option surface (deferred-additive).
        type NotAKeyOf<T, K extends string> = K extends keyof T ? false : true;
        const noCachedEra: NotAKeyOf<NonNullable<ConstructorParameters<typeof Client>[1]>, 'cachedEra'> = true;
        expect(noCachedEra).toBe(true);
    });
});

/* ------------------------------------------------------------------------- *
 * Probe send-error classification: auth-gated servers propagate the
 * UnauthorizedError unchanged (finishAuth() + reconnect probes again); other
 * send failures stay typed negotiation errors.
 * ------------------------------------------------------------------------- */

describe('probe send-error classification', () => {
    /** Rejects the probe send with `probeError`, then serves legacy initialize. */
    class AuthGatedTransport extends ScriptedTransport {
        constructor(private readonly probeError: Error) {
            super(legacyServerScript);
        }

        override async send(message: JSONRPCMessage): Promise<void> {
            if (isJSONRPCRequest(message) && message.method === 'server/discover') {
                throw this.probeError;
            }
            await super.send(message);
        }
    }

    test('UnauthorizedError from the probe send propagates unchanged — no fallback, no second auth round (finishAuth + reconnect probes again)', async () => {
        const reason = new UnauthorizedError();
        const transport = new AuthGatedTransport(reason);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        const rejection = await client.connect(transport).then(
            () => {
                throw new Error('connect unexpectedly resolved');
            },
            (e: unknown) => e
        );

        // The original error, unwrapped: callers dispatch finishAuth() on it.
        expect(rejection).toBe(reason);
        // No initialize fallback ran — that would re-trigger the transport's
        // auth flow (a second authorization prompt) and pin an auth-gated
        // modern server to the legacy era.
        expect(requests(transport.sent).some(r => r.method === 'initialize')).toBe(false);
    });

    test("a foreign auth error matching only by name === 'UnauthorizedError' propagates the same way", async () => {
        class ForeignUnauthorizedError extends Error {
            override readonly name = 'UnauthorizedError';
        }
        const reason = new ForeignUnauthorizedError('401 from middleware');
        const transport = new AuthGatedTransport(reason);
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        const rejection = await client.connect(transport).then(
            () => {
                throw new Error('connect unexpectedly resolved');
            },
            (e: unknown) => e
        );
        expect(rejection).toBe(reason);
        expect(requests(transport.sent).some(r => r.method === 'initialize')).toBe(false);
    });

    test('a plain send failure stays a typed negotiation error — no fallback runs', async () => {
        const transport = new AuthGatedTransport(new Error('connection refused'));
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        const rejection = await client.connect(transport).then(
            () => {
                throw new Error('connect unexpectedly resolved');
            },
            (e: unknown) => e
        );
        expect(rejection).toBeInstanceOf(SdkError);
        expect((rejection as SdkError).code).toBe(SdkErrorCode.EraNegotiationFailed);
        expect(requests(transport.sent).some(r => r.method === 'initialize')).toBe(false);
    });
});

/* ------------------------------------------------------------------------- *
 * Probe window handler preservation: handlers pre-set on the transport
 * before connect() survive negotiation exactly as they survive a plain
 * connect — Protocol.connect() must find and chain them after the window.
 * ------------------------------------------------------------------------- */

describe('probe window preserves pre-set transport handlers', () => {
    test('pre-set onerror/onclose are restored after a modern negotiation and reachable through the Protocol chain', async () => {
        const transport = new ScriptedTransport(modernServerScript());
        const seenErrors: Error[] = [];
        let closed = 0;
        transport.onerror = error => {
            seenErrors.push(error);
        };
        transport.onclose = () => {
            closed++;
        };

        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);

        // The window restored the handler, so Protocol.connect chained it:
        // post-connect transport errors still reach the pre-set observer.
        const boom = new Error('post-connect transport error');
        transport.onerror?.(boom);
        expect(seenErrors).toContain(boom);

        await client.close();
        expect(closed).toBeGreaterThan(0);
    });

    test('pre-set onerror survives the legacy fallback path too', async () => {
        const transport = new ScriptedTransport(legacyServerScript);
        const seenErrors: Error[] = [];
        transport.onerror = error => {
            seenErrors.push(error);
        };

        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');

        const boom = new Error('post-fallback transport error');
        transport.onerror?.(boom);
        expect(seenErrors).toContain(boom);

        await client.close();
    });

    test('failed negotiation (pin mode, no fallback) restores handlers via the detach path — onclose fires exactly once', async () => {
        const transport = new ScriptedTransport(legacyServerScript);
        const presetOnError = (_error: Error) => {};
        let closes = 0;
        transport.onerror = presetOnError;
        transport.onclose = () => {
            closes++;
        };

        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: { pin: MODERN } } });
        await expect(client.connect(transport)).rejects.toThrow();

        // detach() restored the pre-set handlers, and Client's cleanup close
        // delivered the close event exactly once.
        expect(transport.onerror).toBe(presetOnError);
        expect(closes).toBe(1);
    });

    test('a mid-probe transport close reaches the pre-set onclose exactly once (no re-delivery from cleanup close)', async () => {
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                t.onclose?.();
                return;
            }
            legacyServerScript(message, t);
        };
        const transport = new ScriptedTransport(script);
        let closes = 0;
        transport.onclose = () => {
            closes++;
        };

        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport).catch(() => undefined);

        expect(closes).toBe(1);

        // The spent-close guard was disarmed once the cleanup close settled
        // (ScriptedTransport.close() re-fires onclose, like the real HTTP
        // transport — the guard consumed exactly that re-delivery). A LATER
        // close is genuine and must reach the pre-set observer directly.
        transport.onclose?.();
        expect(closes).toBe(2);
    });

    test('a negotiation that SUCCEEDS after a same-tick reply-then-close keeps the observer armed for the live session', async () => {
        // The success-path corner: the reply settles the exchange, then the
        // close arrives in the same tick — forwarded with nothing pending, so
        // negotiation still classifies the reply and succeeds. No cleanup
        // close ever runs on success, so no re-delivery is coming: the guard
        // must be disarmed before Protocol chains the handler slot, or the
        // session's first genuine close would be swallowed.
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                t.reply({ jsonrpc: '2.0', id: message.id, error: { code: -32_601, message: 'Method not found' } });
                t.onclose?.();
                return;
            }
            legacyServerScript(message, t);
        };
        const transport = new ScriptedTransport(script);
        let closes = 0;
        transport.onclose = () => {
            closes++;
        };

        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);
        expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
        // The mid-window close was forwarded exactly once.
        expect(closes).toBe(1);

        // The session's own close is genuine and must reach the observer.
        await client.close();
        expect(closes).toBe(2);
    });

    test("stdio-semantics transport (close() never re-fires onclose): a restarted life's genuine close reaches the pre-set observer after a failed negotiation", async () => {
        // Real stdio semantics: onclose fires only from the child's own close
        // event — the cleanup close() on a dead transport re-delivers NOTHING,
        // so the spent-close guard cannot rely on that re-delivery to consume
        // its skip. It is disarmed from the cleanup site instead, once the
        // cleanup close has settled. Ordering note: a naive self-restoring
        // wrapper would NOT fix this — with no re-delivery ever coming, the
        // wrapper's FIRST invocation would already be the next genuine close,
        // swallowed even as it restores the handler.
        class NoRefireStdioShapedTransport implements Transport {
            onclose?: () => void;
            onerror?: (error: Error) => void;
            onmessage?: (message: JSONRPCMessage) => void;
            sessionId?: string;
            startCalls = 0;
            sent: JSONRPCMessage[] = [];
            private _alive = false;
            get stderr(): null {
                return null;
            }
            get pid(): number | null {
                return this._alive ? 4242 : null;
            }
            async start(): Promise<void> {
                this._alive = true;
                this.startCalls++;
            }
            async send(message: JSONRPCMessage): Promise<void> {
                if (!this._alive) throw new Error('Not connected');
                this.sent.push(message);
                queueMicrotask(() => {
                    if (!this._alive || !isJSONRPCRequest(message)) return;
                    // Exits on the probe, like an rmcp child: the close event.
                    this.simulateChildClose();
                });
            }
            async close(): Promise<void> {
                // stdio semantics: close() tears down but never re-fires
                // onclose — the child's close event already delivered it.
                this._alive = false;
            }
            /** The child's own close event — the only onclose source, like the real transport. */
            simulateChildClose(): void {
                this._alive = false;
                this.onclose?.();
            }
        }

        const transport = new NoRefireStdioShapedTransport();
        let closes = 0;
        transport.onclose = () => {
            closes++;
        };
        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });

        // No _serverParams: probes in place; the mid-probe close is a typed error.
        await expect(client.connect(transport)).rejects.toThrow(/connection closed during the server\/discover probe/);
        // The child's death mid-probe was forwarded to the observer exactly once
        // (the cleanup close, per stdio semantics, re-delivered nothing).
        expect(closes).toBe(1);

        // The caller restarts the transport; the new life's death is a GENUINE
        // close and must reach the observer — an armed skip would swallow it.
        await transport.start();
        transport.simulateChildClose();
        expect(closes).toBe(2);
    });

    test('transport errors DURING the probe window are forwarded to the pre-set handler', async () => {
        const duringProbe = new Error('mid-probe transport error');
        const script: Script = (message, t) => {
            if (!isJSONRPCRequest(message)) return;
            if (message.method === 'server/discover') {
                t.onerror?.(duringProbe);
                t.reply({ jsonrpc: '2.0', id: message.id, error: { code: -32_601, message: 'Method not found' } });
                return;
            }
            legacyServerScript(message, t);
        };
        const transport = new ScriptedTransport(script);
        const seenErrors: Error[] = [];
        transport.onerror = error => {
            seenErrors.push(error);
        };

        const client = new Client({ name: 'c', version: '0' }, { versionNegotiation: { mode: 'auto' } });
        await client.connect(transport);

        expect(seenErrors).toContain(duringProbe);
        await client.close();
    });
});
