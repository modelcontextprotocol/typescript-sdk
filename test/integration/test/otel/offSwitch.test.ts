import type { ClientOptions } from '@modelcontextprotocol/client';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServerOptions } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { SpanKind } from '@opentelemetry/api';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { registerTestSdk } from './sdk';

const sdk = registerTestSdk();
beforeEach(() => sdk.reset());
afterAll(() => sdk.unregister());

/** Calls one tool and returns the `_meta` its handler received. */
async function callTool(clientOptions: ClientOptions, serverOptions: McpServerOptions) {
    let meta: unknown;
    const server = new McpServer({ name: 'weather', version: '1.0.0' }, serverOptions);
    server.registerTool('get-weather', { inputSchema: z.object({}) }, (_args, ctx) => {
        meta = ctx.mcpReq._meta;
        return { content: [] };
    });
    const client = new Client({ name: 'agent', version: '1.0.0' }, clientOptions);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: 'get-weather', arguments: {} });
    await client.close();
    return meta;
}

describe('openTelemetry: false', () => {
    it('records nothing and leaves _meta untouched, even with an SDK registered', async () => {
        const meta = await callTool({ openTelemetry: false }, { openTelemetry: false });

        expect(meta).toBeUndefined();
        expect(sdk.spans()).toHaveLength(0);
        await expect(sdk.histogram('mcp.client.operation.duration')).rejects.toThrow('no mcp.client.operation.duration metric');
        await expect(sdk.histogram('mcp.server.operation.duration')).rejects.toThrow('no mcp.server.operation.duration metric');
    });

    it('turns off only the instance it is passed to', async () => {
        const meta = await callTool({}, { openTelemetry: false });

        const clientSpan = sdk.span('tools/call get-weather', SpanKind.CLIENT);
        const { traceId, spanId } = clientSpan.spanContext();
        expect(meta).toEqual({ traceparent: `00-${traceId}-${spanId}-01` });
        expect(sdk.spans().filter(span => span.kind === SpanKind.SERVER)).toHaveLength(0);
    });
});
