import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import type { JSONRPCRequest, ServerCapabilities } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport } from '@modelcontextprotocol/core-internal';

import type { ClientOptions } from '../../../src/client/client';
import { Client } from '../../../src/client/client';

export const MODERN = '2026-07-28';
export const LEGACY = '2025-11-25';

export type Handler = (params: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface Call {
    method: string;
    params: Record<string, unknown>;
}

/** A JSON-RPC error for the scripted server to answer with. */
export class RpcError extends Error {
    constructor(
        readonly code: number,
        message: string
    ) {
        super(message);
    }
}

/**
 * A client connected on `revision` (default 2026-07-28) to a scripted server:
 * `server/discover` or `initialize` declares `capabilities`, every other
 * request goes to `handlers` and is recorded in `calls`. On 2026-07-28 results
 * carry `resultType: "complete"` as a conforming server's do (the
 * typescript-sdk#2789 regression).
 */
export async function scriptedClient(
    capabilities: ServerCapabilities,
    handlers: Record<string, Handler>,
    options: ClientOptions = {},
    revision: typeof MODERN | typeof LEGACY = MODERN
): Promise<{ client: Client; calls: Call[] }> {
    const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
    const calls: Call[] = [];
    const answer = async (request: JSONRPCRequest): Promise<Record<string, unknown>> => {
        if (revision === MODERN && request.method === 'server/discover') {
            return {
                supportedVersions: [MODERN],
                capabilities,
                _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'scripted', version: '1.0.0' } }
            };
        }
        if (revision === LEGACY && request.method === 'initialize') {
            return { protocolVersion: LEGACY, capabilities, serverInfo: { name: 'scripted', version: '1.0.0' } };
        }
        const params = (request.params ?? {}) as Record<string, unknown>;
        calls.push({ method: request.method, params });
        const handler = handlers[request.method];
        if (handler === undefined) throw new RpcError(-32_601, `Method not found: ${request.method}`);
        return handler(params);
    };
    serverTx.onmessage = message => {
        const request = message as JSONRPCRequest;
        if (request.id === undefined) return;
        void answer(request).then(
            result =>
                serverTx.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: revision === MODERN ? { resultType: 'complete', ...result } : result
                }),
            (error: unknown) =>
                serverTx.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    error: {
                        code: error instanceof RpcError ? error.code : -32_603,
                        message: error instanceof Error ? error.message : String(error)
                    }
                })
        );
    };
    await serverTx.start();
    const client = new Client(
        { name: 'skills-test-client', version: '1.0.0' },
        revision === MODERN ? { versionNegotiation: { mode: { pin: MODERN } }, ...options } : options
    );
    await client.connect(clientTx);
    return { client, calls };
}

export interface SkillsHandlerOptions {
    /** Entries per `skills/list` page. Default: all. */
    pageSize?: number;
    /** `ttlMs` on `resources/read` results; above 0 the client caches them. Default: 0 (not cached). */
    readTtlMs?: number;
}

/** A conforming skills server over `skills` and the file contents in `files` (keyed by URI as published). */
export function skillsHandlers(
    skills: readonly Skill[],
    files: ReadonlyMap<string, string | Uint8Array>,
    options: SkillsHandlerOptions = {}
): Record<string, Handler> {
    const pageSize = options.pageSize ?? Number.POSITIVE_INFINITY;
    return {
        'skills/list': params => {
            const start = params['cursor'] === undefined ? 0 : Number(params['cursor']);
            const end = start + pageSize;
            return {
                skills: skills.slice(start, end),
                ttlMs: 60_000,
                cacheScope: 'public',
                ...(end < skills.length && { nextCursor: String(end) })
            };
        },
        'skills/get': params => {
            const skill = skills.find(candidate => candidate.uri === params['uri']);
            if (skill === undefined) throw new RpcError(-32_602, `No skill is served at ${String(params['uri'])}`);
            return { skill, ttlMs: 0, cacheScope: 'private' };
        },
        'resources/read': params => {
            const uri = String(params['uri']);
            const content = files.get(uri);
            if (content === undefined) throw new RpcError(-32_602, `Resource not found: ${uri}`);
            const body =
                typeof content === 'string'
                    ? { uri, mimeType: 'text/markdown', text: content }
                    : { uri, mimeType: 'application/octet-stream', blob: Buffer.from(content).toString('base64') };
            // 2026-07-28 requires both caching fields on every cacheable result.
            return { contents: [body], ttlMs: options.readTtlMs ?? 0, cacheScope: 'private' };
        }
    };
}
