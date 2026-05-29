import type { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage, ProtocolConfig, Transport, TransportSendOptions } from '@modelcontextprotocol/core';
import { isJSONRPCRequest, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core';

import { ModernProtocolHandler } from './modernHandler.js';
import { LegacyServer } from './server.js';
import { LegacyStdioServerTransport } from './stdio.js';

type ProtocolGeneration = 'legacy' | 'modern';

class VirtualStdioTransport implements Transport {
    onmessage?: Transport['onmessage'];
    onclose?: () => void;
    onerror?: (error: Error) => void;
    sessionId?: string;

    constructor(private _realSend: (msg: JSONRPCMessage) => Promise<void>) {}

    async start(): Promise<void> {
        // No-op — the real I/O transport is already started
    }

    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        return this._realSend(message);
    }

    async close(): Promise<void> {
        this.onclose?.();
    }

    pushMessage(msg: JSONRPCMessage): void {
        this.onmessage?.(msg);
    }
}

/**
 * Dual-protocol stdio server transport with automatic version detection.
 *
 * Detects the client's protocol version from the first message and locks
 * for the connection lifetime. Modern clients (2026-06) are dispatched to
 * a stateless ModernProtocolHandler. Legacy clients (2025-11) get a full
 * LegacyServer connected via a VirtualStdioTransport adapter.
 *
 * The routing transport always owns inner.onmessage — both paths go
 * through _routeMessage(). This ensures symmetric behavior and prevents
 * race conditions.
 *
 * Drop-in replacement for LegacyStdioServerTransport with no changes to
 * McpServer, Server, or tool handlers.
 */
export class StdioServerTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: Transport['onmessage'];
    sessionId?: string;

    private _inner: LegacyStdioServerTransport;
    private _protocolConfig?: ProtocolConfig;
    private _modernHandler?: ModernProtocolHandler;
    private _legacyServer?: LegacyServer;
    private _virtualTransport?: VirtualStdioTransport;
    private _lockedMode: ProtocolGeneration | null = null;
    private _modernQueue: Promise<void> = Promise.resolve();

    constructor(stdin?: Readable, stdout?: Writable) {
        this._inner = new LegacyStdioServerTransport(stdin, stdout);
    }

    setProtocolConfig(config: ProtocolConfig): void {
        this._protocolConfig = config;
        this._modernHandler = new ModernProtocolHandler({
            requestHandlers: config.requestHandlers,
            serverInfo: config.serverInfo!,
            capabilities: config.capabilities!,
            instructions: config.instructions
        });
    }

    async start(): Promise<void> {
        this._inner.onerror = error => this.onerror?.(error);
        this._inner.onclose = () => this.onclose?.();
        this._inner.onmessage = msg => this._routeMessage(msg);
        await this._inner.start();
    }

    async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
        return this._inner.send(message);
    }

    async close(): Promise<void> {
        if (this._legacyServer) {
            await this._legacyServer.close();
        }
        await this._inner.close();
    }

    // -------------------------------------------------------------------
    // Version detection and routing
    // -------------------------------------------------------------------

    private _routeMessage(msg: JSONRPCMessage): void {
        if (this._lockedMode === null) {
            this._lockedMode = this._detectVersion(msg);
            if (this._lockedMode === 'legacy') {
                this._initLegacyPath();
            }
        }

        if (this._lockedMode === 'modern') {
            this._handleModernMessage(msg);
        } else {
            this._virtualTransport!.pushMessage(msg);
        }
    }

    private _detectVersion(msg: JSONRPCMessage): ProtocolGeneration {
        if (!isJSONRPCRequest(msg)) {
            return 'legacy';
        }
        if (msg.method === 'initialize') {
            return 'legacy';
        }
        if (msg.method === 'server/discover') {
            return 'modern';
        }
        if (
            (msg.params as Record<string, unknown> | undefined)?._meta &&
            ((msg.params as Record<string, unknown>)._meta as Record<string, unknown>)?.protocolVersion
        ) {
            return 'modern';
        }
        return 'legacy';
    }

    /**
     * Synchronous initialization of the legacy path.
     *
     * Protocol.connect() sets virtualTransport.onmessage synchronously
     * at the start of connect(), so pushMessage() works immediately —
     * even though connect() itself is async (its awaited start() is a no-op).
     */
    private _initLegacyPath(): void {
        const config = this._protocolConfig!;

        this._virtualTransport = new VirtualStdioTransport(msg => this._inner.send(msg));

        this._legacyServer = config.createServer
            ? (config.createServer() as LegacyServer)
            : new LegacyServer(config.serverInfo!, {
                  capabilities: config.capabilities
              });

        this._legacyServer.fallbackRequestHandler = async (request, ctx) => {
            const handler = config.requestHandlers.get(request.method);
            if (!handler) {
                throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Method not found: ${request.method}`);
            }
            return handler(request, ctx);
        };

        this._legacyServer.connect(this._virtualTransport).catch(error => {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        });
    }

    /**
     * Dispatches a modern-path message. Requests go to ModernProtocolHandler;
     * responses are written to stdout via inner.send().
     *
     * Processing is serialized to prevent interleaved stdout writes from
     * concurrent async handlers.
     */
    private _handleModernMessage(msg: JSONRPCMessage): void {
        this._modernQueue = this._modernQueue
            .then(async () => {
                if (!this._modernHandler) return;

                if (isJSONRPCRequest(msg)) {
                    const response = await this._modernHandler.handleRequest(msg);
                    await this._inner.send(response);
                }
            })
            .catch(error => {
                this.onerror?.(error instanceof Error ? error : new Error(String(error)));
            });
    }
}
