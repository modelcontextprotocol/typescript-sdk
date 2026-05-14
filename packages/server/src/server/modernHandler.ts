import type {
    AuthInfo,
    Implementation,
    JSONRPCErrorResponse,
    JSONRPCRequest,
    JSONRPCResponse,
    Result,
    ServerCapabilities,
    ServerContext
} from '@modelcontextprotocol/core';
import { ProtocolErrorCode } from '@modelcontextprotocol/core';

export interface ModernHandlerOptions {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    requestHandlers: ReadonlyMap<string, (request: JSONRPCRequest, ctx: any) => Promise<Result>>;
    serverInfo: Implementation;
    capabilities: ServerCapabilities;
    instructions?: string;
}

export class ModernProtocolHandler {
    constructor(private options: ModernHandlerOptions) {}

    async handleRequest(
        request: JSONRPCRequest,
        extra?: { authInfo?: AuthInfo; request?: globalThis.Request }
    ): Promise<JSONRPCResponse | JSONRPCErrorResponse> {
        const method = request.method;

        if (method === 'server/discover') {
            return this.handleDiscover(request);
        }

        const handler = this.options.requestHandlers.get(method);
        if (!handler) {
            return this.jsonRpcError(request.id, ProtocolErrorCode.MethodNotFound, `Method not found: ${method}`);
        }

        const meta = request.params?._meta;
        if (!meta?.protocolVersion) {
            return this.jsonRpcError(request.id, ProtocolErrorCode.InvalidRequest, 'Missing _meta.protocolVersion');
        }

        const ctx = this.buildContext(request, extra);
        try {
            const result = await handler(request, ctx);
            return {
                jsonrpc: '2.0',
                id: request.id,
                result: { ...result, result_type: 'complete' }
            };
        } catch (error: unknown) {
            const err = error as Record<string, unknown>;
            return {
                jsonrpc: '2.0',
                id: request.id,
                error: {
                    code: Number.isSafeInteger(err['code']) ? (err['code'] as number) : ProtocolErrorCode.InternalError,
                    message: (err as unknown as Error).message ?? 'Internal error',
                    ...(err['data'] !== undefined && { data: err['data'] })
                }
            };
        }
    }

    private handleDiscover(request: JSONRPCRequest): JSONRPCResponse {
        return {
            jsonrpc: '2.0',
            id: request.id,
            result: {
                supportedVersions: ['2026-06-30'],
                capabilities: this.options.capabilities,
                serverInfo: this.options.serverInfo,
                ...(this.options.instructions && { instructions: this.options.instructions })
            }
        };
    }

    private buildContext(request: JSONRPCRequest, extra?: { authInfo?: AuthInfo; request?: globalThis.Request }): ServerContext {
        const abortController = new AbortController();
        return {
            sessionId: undefined,
            mcpReq: {
                id: request.id,
                method: request.method,
                _meta: request.params?._meta,
                signal: abortController.signal,
                send: (async () => {
                    throw new Error('Server-to-client requests are not supported on the stateless 2026-06 path');
                }) as ServerContext['mcpReq']['send'],
                notify: async () => {
                    /* no-op: notifications deferred on modern path */
                },
                log: async () => {
                    /* no-op: in-band logging deferred on modern path */
                },
                elicitInput: async () => {
                    throw new Error('Elicitation is not supported on the stateless 2026-06 path');
                },
                requestSampling: async () => {
                    throw new Error('Sampling is not supported on the stateless 2026-06 path');
                }
            },
            http: extra
                ? {
                      authInfo: extra.authInfo,
                      req: extra.request
                  }
                : undefined
        };
    }

    private jsonRpcError(id: JSONRPCRequest['id'], code: number, message: string): JSONRPCErrorResponse {
        return {
            jsonrpc: '2.0',
            id,
            error: { code, message }
        };
    }
}
