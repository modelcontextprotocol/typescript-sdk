import type {
    AuthInfo,
    BaseContext,
    HandlerRegistry,
    JSONRPCMessage,
    JSONRPCRequest,
    MessageExtraInfo,
    Result,
    ServerCapabilities,
    Transport
} from '@modelcontextprotocol/core';
import { isJSONRPCRequest, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/core';

import { BridgeTransport } from './bridgeTransport.js';
import type { McpServer } from './mcp.js';
import { Server } from './server.js';

export type McpEra = 'legacy' | 'modern';

export interface TransportMeta {
    httpHeaders?: Record<string, string>;
    httpMethod?: string;
    authInfo?: unknown;
    connectionId?: string;
}

export interface LegacySession {
    readonly id: string;
    injectMessage(message: JSONRPCMessage, extra?: MessageExtraInfo): void;
    onOutgoing?: (message: JSONRPCMessage) => void;
    close(): Promise<void>;
    onclose?: () => void;
}

export interface DiscoverResult {
    serverInfo: { name: string; version: string };
    capabilities: ServerCapabilities;
    supportedVersions: string[];
    instructions?: string;
}

export interface VersionRouterOptions {
    legacySupport?: boolean;
    forceLegacy?: boolean;
    supportedVersions?: string[];
}

let sessionIdCounter = 0;

export abstract class McpVersionRouter {
    private _serveSession?: LegacySession;

    constructor(
        protected mcpServer: McpServer,
        protected options?: VersionRouterOptions
    ) {}

    abstract classify(message: JSONRPCMessage, meta?: TransportMeta): McpEra;

    async handleModernRequest(request: JSONRPCRequest, meta?: TransportMeta): Promise<Result> {
        // server/discover is handled by the router itself, not dispatched to McpServer.
        if (request.method === 'server/discover') {
            return this.handleDiscover() as unknown as Result;
        }

        return this.mcpServer.dispatch(request.method, request, {
            http: meta?.authInfo ? { authInfo: meta.authInfo as AuthInfo } : undefined
        });
    }

    handleDiscover(): DiscoverResult {
        // Ensure lazy-registered tools/resources/prompts are materialized so
        // capabilities reflect them in the discover response.
        this.mcpServer.ensureInitialized();

        const serverInfo = this.mcpServer.server.getServerInfo();
        const capabilities = this.mcpServer.server.getCapabilities();
        return {
            serverInfo,
            capabilities,
            supportedVersions: this.options?.supportedVersions ?? ['2026-06-30', '2025-11-05'],
            instructions: this.mcpServer.server.getInstructions()
        };
    }

    createLegacySession(options?: { sessionId?: string }): LegacySession {
        const id = options?.sessionId ?? `legacy-session-${++sessionIdCounter}`;
        const bridge = new BridgeTransport();

        const serverInfo = this.mcpServer.server.getServerInfo();
        const serverCaps = this.mcpServer.server.getCapabilities();

        const server = new Server(serverInfo, {
            capabilities: serverCaps,
            instructions: this.mcpServer.server.getInstructions(),
            registry: this.mcpServer.registry as unknown as HandlerRegistry<BaseContext>
        });
        server.connect(bridge);

        const session: LegacySession = {
            id,
            injectMessage(message: JSONRPCMessage, extra?: MessageExtraInfo) {
                bridge.injectIncoming(message, extra);
            },
            set onOutgoing(cb: ((msg: JSONRPCMessage) => void) | undefined) {
                bridge.onOutgoing = cb;
            },
            get onOutgoing() {
                return bridge.onOutgoing;
            },
            async close() {
                await server.close();
                session.onclose?.();
            },
            onclose: undefined
        };

        return session;
    }

    async serve(transport: Transport): Promise<void> {
        await transport.start();

        transport.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => {
            const era = this.options?.forceLegacy ? ('legacy' as McpEra) : this.classify(message, extra as TransportMeta | undefined);

            if (era === 'modern' && isJSONRPCRequest(message)) {
                this.handleModernRequest(message, extra as TransportMeta)
                    .then(result => {
                        transport.send({
                            jsonrpc: '2.0',
                            id: message.id,
                            result
                        });
                    })
                    .catch(error => {
                        const code = error instanceof ProtocolError ? error.code : ProtocolErrorCode.InternalError;
                        transport.send({
                            jsonrpc: '2.0',
                            id: message.id,
                            error: { code, message: error.message }
                        });
                    });
            } else if (era === 'legacy') {
                // Create a legacy session on first legacy message, reuse for subsequent ones.
                if (!this._serveSession) {
                    this._serveSession = this.createLegacySession();
                    this._serveSession.onOutgoing = msg => transport.send(msg);
                }
                this._serveSession.injectMessage(message, extra);
            }
        };

        transport.onclose = () => this.close();
    }

    async close(): Promise<void> {
        if (this._serveSession) {
            await this._serveSession.close();
            this._serveSession = undefined;
        }
    }
}
