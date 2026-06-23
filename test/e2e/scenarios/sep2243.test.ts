/**
 * SEP-2243 request-metadata headers (protocol revision 2026-07-28).
 *
 * End-to-end cells for the SEP-2243 header families over the dual-era HTTP
 * entry (`createMcpHandler`), exercised on the wire() `entryModern` arm so the
 * raw HTTP request headers are observable on the arm-recorded `wired.httpLog`.
 */
import { Client } from '@modelcontextprotocol/client';
import { encodeMcpParamValue, MCP_PARAM_HEADER_PREFIX } from '@modelcontextprotocol/core';
import { fromJsonSchema, McpServer } from '@modelcontextprotocol/server';
import { expect } from 'vitest';

import { modernEnvelopeMeta, wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

/**
 * One tool with a single `x-mcp-header`-declared string parameter. Declared as
 * a non-literal const so the JSON-Schema vendor extension key passes excess
 * property checking on `fromJsonSchema`'s `JSONSchema.Interface` parameter.
 */
const LOCATE_INPUT_SCHEMA = {
    type: 'object',
    properties: { region: { type: 'string', 'x-mcp-header': 'Region' } },
    required: ['region']
};

verifies('sep-2243:param-header:roundtrip', async ({ transport }: TestArgs) => {
    // The server is built by createMcpHandler per request, so its pre-dispatch
    // Mcp-Param-* validation runs against this schema.
    const makeServer = () => {
        const server = new McpServer({ name: 'e2e-sep2243', version: '1.0.0' }, { capabilities: { tools: {} } });
        server.registerTool('locate', { inputSchema: fromJsonSchema<{ region: string }>(LOCATE_INPUT_SCHEMA) }, ({ region }) => ({
            content: [{ type: 'text', text: `region=${region}` }]
        }));
        return server;
    };
    const client = new Client({ name: 'sep2243-client', version: '1.0.0' });
    await using wired = await wire(transport, makeServer, client);

    // listTools() auto-aggregates and writes the response cache; callTool
    // reads it directly and emits the header on its first attempt (the
    // spec's 5-step client algorithm).
    await client.listTools();
    const result = await client.callTool({ name: 'locate', arguments: { region: 'us-west1' } });

    // The tools/call HTTP request carries the Mcp-Param-Region header,
    // encoded per the SEP-2243 value-encoding rules (a safe ASCII token
    // passes through unchanged).
    const callExchange = (wired.httpLog ?? []).find(exchange => exchange.requestBody?.includes('"tools/call"'));
    expect(callExchange).toBeDefined();
    const headerValue = callExchange!.requestHeaders.get(`${MCP_PARAM_HEADER_PREFIX}Region`);
    expect(headerValue).toBe(encodeMcpParamValue('us-west1'));
    expect(headerValue).toBe('us-west1');

    // The call succeeded against the validating server (header agreed with
    // the body argument, so no -32020 HeaderMismatch on the wire).
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'region=us-west1' }]);
});

verifies('sep-2243:std-header:mismatch-rejected', async ({ transport }: TestArgs) => {
    const makeServer = () => new McpServer({ name: 'e2e-sep2243-std', version: '1.0.0' }, { capabilities: { tools: {} } });
    const client = new Client({ name: 'sep2243-std-client', version: '1.0.0' });
    await using wired = await wire(transport, makeServer, client);

    // Raw POST through the harness-hosted entry: the body is a valid
    // envelope-carrying tools/call, but the Mcp-Method header names
    // tools/list. The era-classification rung answers the disagreement
    // before any factory instance is constructed.
    const response = await wired.fetch!(wired.url!, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-method': 'tools/list'
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'locate', arguments: {}, _meta: modernEnvelopeMeta({ name: 'sep2243-std-client', version: '1.0.0' }) }
        })
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number; message: string } };
    // -32020 is the SEP-2243 HeaderMismatch code (post-spec#2907 renumber).
    expect(body.error.code).toBe(-32_020);
    expect(body.error.message).toMatch(/Mcp-Method/);
});
