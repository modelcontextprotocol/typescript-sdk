import type { JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core-internal';

import { invoke } from '../../../src/server/invoke';
import { McpServer } from '../../../src/server/mcp';

export const MODERN = '2026-07-28';
export const LEGACY = '2025-11-25';

export interface Reply {
    result?: Record<string, unknown>;
    error?: { code: number; message: string; data?: unknown };
}

let nextId = 1;

export function newServer(): McpServer {
    return new McpServer({ name: 'skills-test', version: '1.0.0' });
}

/** Sends one JSON-RPC request through the real dispatch path, on the given protocol revision. */
export async function call(
    mcp: McpServer,
    method: string,
    params: Record<string, unknown> = {},
    revision: string = MODERN
): Promise<Reply> {
    const modern = revision === MODERN;
    const classification: MessageClassification = modern ? { era: 'modern', revision } : { era: 'legacy', revision };
    const meta = modern
        ? {
              [PROTOCOL_VERSION_META_KEY]: MODERN,
              [CLIENT_INFO_META_KEY]: { name: 'skills-test-client', version: '1.0.0' },
              [CLIENT_CAPABILITIES_META_KEY]: {}
          }
        : undefined;
    const message = {
        jsonrpc: '2.0',
        id: nextId++,
        method,
        params: meta === undefined ? params : { ...params, _meta: meta }
    } as JSONRPCRequest;
    setNegotiatedProtocolVersion(mcp.server, revision);
    const response = await invoke(mcp, message, { classification });
    return (await response.json()) as Reply;
}

/** The result of a request that must succeed. */
export async function resultOf(
    mcp: McpServer,
    method: string,
    params: Record<string, unknown> = {},
    revision: string = MODERN
): Promise<Record<string, unknown>> {
    const reply = await call(mcp, method, params, revision);
    if (reply.result === undefined) throw new Error(`${method} failed: ${JSON.stringify(reply.error)}`);
    return reply.result;
}

/** The error of a request that must fail. */
export async function errorOf(
    mcp: McpServer,
    method: string,
    params: Record<string, unknown> = {},
    revision: string = MODERN
): Promise<NonNullable<Reply['error']>> {
    const reply = await call(mcp, method, params, revision);
    if (reply.error === undefined) throw new Error(`${method} unexpectedly succeeded`);
    return reply.error;
}
