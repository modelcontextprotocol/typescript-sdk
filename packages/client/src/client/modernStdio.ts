import type { Stream } from 'node:stream';

import type { JSONRPCMessage, MessageExtraInfo, TransportSendOptions } from '@modelcontextprotocol/core';
import { isJSONRPCResultResponse } from '@modelcontextprotocol/core';

import type { DiscoverResult } from './modernClientImpl.js';
import type { StdioServerParameters } from './stdio.js';
import { LegacyStdioClientTransport } from './stdio.js';
import type { VersionProbingTransport } from './versionProbing.js';

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

export type StdioClientTransportOptions = StdioServerParameters & {
    /** Skip version probing and always use legacy mode. */
    forceLegacy?: boolean;
    /** Timeout for the server/discover probe in milliseconds. Default: 5000. */
    probeTimeoutMs?: number;
};

/**
 * Dual-protocol stdio client transport with automatic version probing.
 *
 * During {@linkcode start | start()}, spawns the server process and sends a
 * `server/discover` probe. If the server responds with a valid DiscoverResult,
 * the transport operates in modern mode. Otherwise, falls back to legacy mode.
 */
export class StdioClientTransport implements VersionProbingTransport {
    private _inner: LegacyStdioClientTransport;
    private _mode: 'modern' | 'legacy' = 'legacy';
    private _discoverResult?: DiscoverResult;
    private _started = false;
    private _forceLegacy: boolean;
    private _probeTimeoutMs: number;

    private _probeResolve?: (result: DiscoverResult | null) => void;
    private _probeTimeout?: ReturnType<typeof setTimeout>;
    private _pendingMessages: JSONRPCMessage[] = [];
    private _probeId: string = crypto.randomUUID();

    private _onclose?: (() => void) | undefined;
    private _onerror?: ((error: Error) => void) | undefined;
    private _onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

    constructor(options: StdioClientTransportOptions) {
        this._forceLegacy = options.forceLegacy ?? false;
        this._probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
        this._inner = new LegacyStdioClientTransport(options);
    }

    async start(): Promise<void> {
        if (this._started) {
            return;
        }
        this._started = true;

        await this._inner.start();

        if (this._forceLegacy) {
            return;
        }

        try {
            const result = await this._probeDiscover();
            if (result) {
                this._mode = 'modern';
                this._discoverResult = result;
            }
        } catch {
            // Any failure = legacy mode
        }
    }

    get mode(): 'modern' | 'legacy' {
        return this._mode;
    }

    getDiscoverResult(): DiscoverResult | undefined {
        return this._discoverResult;
    }

    get stderr(): Stream | null {
        return this._inner.stderr;
    }

    get pid(): number | null {
        return this._inner.pid;
    }

    // -------------------------------------------------------------------
    // Transport interface delegation
    // -------------------------------------------------------------------

    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        await this._inner.send(message);
    }

    async close(): Promise<void> {
        if (this._probeResolve) {
            clearTimeout(this._probeTimeout);
            this._probeResolve(null);
            this._probeResolve = undefined;
        }
        await this._inner.close();
    }

    set onclose(handler: (() => void) | undefined) {
        this._onclose = handler;
        this._inner.onclose = handler;
    }
    get onclose(): (() => void) | undefined {
        return this._onclose;
    }

    set onerror(handler: ((error: Error) => void) | undefined) {
        this._onerror = handler;
        this._inner.onerror = handler;
    }
    get onerror(): ((error: Error) => void) | undefined {
        return this._onerror;
    }

    set onmessage(handler: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined) {
        this._onmessage = handler;
        this._inner.onmessage = handler;
        for (const msg of this._pendingMessages) {
            handler?.(msg);
        }
        this._pendingMessages = [];
    }
    get onmessage(): (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined {
        return this._onmessage;
    }

    // -------------------------------------------------------------------
    // Probe
    // -------------------------------------------------------------------

    private async _probeDiscover(): Promise<DiscoverResult | null> {
        return new Promise<DiscoverResult | null>(resolve => {
            let resolved = false;
            this._probeResolve = resolve;

            const finish = (result: DiscoverResult | null) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(this._probeTimeout);
                this._probeResolve = undefined;
                this._inner.onmessage = m => this._pendingMessages.push(m);
                resolve(result);
            };

            this._probeTimeout = setTimeout(() => finish(null), this._probeTimeoutMs);

            this._inner.onmessage = (msg: JSONRPCMessage) => {
                const id = (msg as { id?: unknown }).id;
                if (id !== this._probeId) {
                    this._pendingMessages.push(msg);
                    return;
                }

                if (isJSONRPCResultResponse(msg)) {
                    const result = msg.result as Record<string, unknown>;
                    if (Array.isArray(result.supportedVersions) && result.capabilities && result.serverInfo) {
                        finish(result as unknown as DiscoverResult);
                        return;
                    }
                }
                finish(null);
            };

            this._inner
                .send({
                    jsonrpc: '2.0',
                    id: this._probeId,
                    method: 'server/discover',
                    params: {}
                })
                .catch(() => finish(null));
        });
    }
}
