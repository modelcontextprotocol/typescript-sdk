import type { JSONRPCMessage, JSONRPCRequest, MessageExtraInfo, Transport, TransportSendOptions } from '@modelcontextprotocol/core';
import { isJSONRPCRequest } from '@modelcontextprotocol/core';

import type { DiscoverResult } from './modernClientImpl.js';
import type { StreamableHTTPClientTransportOptions } from './streamableHttp.js';
import { StreamableHTTPClientTransport } from './streamableHttp.js';

/**
 * A version-probing HTTP client transport that wraps {@linkcode StreamableHTTPClientTransport}.
 *
 * During {@linkcode start | start()}, it sends a `server/discover` probe to detect whether
 * the server supports the modern (2026-06) MCP protocol. If the probe succeeds, the
 * transport operates in `modern` mode and automatically adds the `Mcp-Method` header
 * to every outgoing request. If the probe fails, the transport falls back to `legacy`
 * mode and behaves identically to a plain {@linkcode StreamableHTTPClientTransport}.
 *
 * Use {@linkcode getDiscoverResult | getDiscoverResult()} after {@linkcode start | start()} to
 * retrieve the server's capabilities when in modern mode.
 */
export class VersionProbingHTTPClientTransport implements Transport {
    private _inner: StreamableHTTPClientTransport;
    private _mode: 'modern' | 'legacy' = 'legacy';
    private _discoverResult?: DiscoverResult;
    private _started = false;

    private _onclose?: (() => void) | undefined;
    private _onerror?: ((error: Error) => void) | undefined;
    private _onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined;

    constructor(url: URL, options?: StreamableHTTPClientTransportOptions) {
        this._inner = new StreamableHTTPClientTransport(url, {
            ...options,
            getExtraHeaders: (message: JSONRPCMessage | JSONRPCMessage[]) => {
                // Merge user-provided extra headers first
                const userExtras = options?.getExtraHeaders?.(message) ?? {};

                if (this._mode === 'modern' && !Array.isArray(message) && isJSONRPCRequest(message)) {
                    return {
                        ...userExtras,
                        'mcp-method': (message as JSONRPCRequest).method
                    };
                }
                return userExtras;
            }
        });
    }

    /**
     * Starts the inner transport, then probes `server/discover` to detect
     * whether the server supports the modern protocol.
     */
    async start(): Promise<void> {
        if (this._started) {
            return;
        }
        this._started = true;

        await this._inner.start();

        try {
            const result = await this._probeFetch();
            if (result) {
                this._mode = 'modern';
                this._discoverResult = result;
            }
        } catch {
            // Any failure means legacy mode -- no action needed
        }
    }

    /**
     * Sends a raw `server/discover` request to the server endpoint to probe
     * for modern protocol support.
     *
     * This bypasses the transport's `send()` to avoid triggering `onmessage`
     * callbacks before the client is fully wired.
     */
    private async _probeFetch(): Promise<DiscoverResult | null> {
        const headers = await this._inner.commonHeaders();
        headers.set('content-type', 'application/json');
        headers.set('accept', 'application/json');
        headers.set('mcp-method', 'server/discover');

        const body: JSONRPCRequest = {
            jsonrpc: '2.0',
            id: 0,
            method: 'server/discover',
            params: {}
        };

        const response = await this._inner.fetchFn(this._inner.url, {
            ...this._inner.requestInit,
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            return null;
        }

        const contentType = response.headers.get('content-type');
        if (!contentType?.includes('application/json')) {
            await response.text?.().catch(() => {});
            return null;
        }

        const data = (await response.json()) as Record<string, unknown>;

        // The response should be a JSON-RPC result containing the discover info
        if (data?.jsonrpc === '2.0' && data?.result) {
            const result = data.result as Record<string, unknown>;
            if (Array.isArray(result.supportedVersions) && result.capabilities && result.serverInfo) {
                return result as unknown as DiscoverResult;
            }
        }

        return null;
    }

    /**
     * Returns the discover result if the server supports the modern protocol,
     * or `undefined` if the server is legacy.
     */
    getDiscoverResult(): DiscoverResult | undefined {
        return this._discoverResult;
    }

    /**
     * Whether the transport is operating in modern or legacy mode.
     */
    get mode(): 'modern' | 'legacy' {
        return this._mode;
    }

    // ---------------------------------------------------------------------------
    // Transport interface delegation
    // ---------------------------------------------------------------------------

    async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
        await this._inner.send(message, options);
    }

    async close(): Promise<void> {
        await this._inner.close();
    }

    get sessionId(): string | undefined {
        return this._inner.sessionId;
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
    }

    get onmessage(): (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined {
        return this._onmessage;
    }

    setProtocolVersion(version: string): void {
        this._inner.setProtocolVersion(version);
    }
}
