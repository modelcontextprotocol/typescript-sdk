/**
 * Self-contained test bodies for Standard Schema (standardschema.dev) support:
 * non-Zod schema libraries (ArkType and Valibot here) passed to registerTool() /
 * registerPrompt(), covering JSON Schema derivation for listings, argument
 * parsing/validation before handlers run, and output-schema enforcement.
 *
 * Each body builds its own server (via a factory), builds its own client, and
 * wires them with {@link wire}. Recorders live outside the factory so stateless
 * hosting (fresh server per request) still observes them.
 */

import { Client } from '@modelcontextprotocol/client';
import { McpServer, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { toStandardJsonSchema } from '@valibot/to-json-schema';
import { type } from 'arktype';
import * as v from 'valibot';
import { expect } from 'vitest';

import { wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

/** Plain client with no extra capabilities declared. */
const newClient = () => new Client({ name: 'c', version: '0' });

verifies('standardschema:tool:arktype-input', async ({ transport }: TestArgs) => {
    // Recorder lives outside the factory so stateless hosting (fresh server per request) shares it.
    const handlerArgs: Array<{ sku: string; quantity: number }> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'submit-order',
            { description: 'Submit an order for a product.', inputSchema: type({ sku: 'string', quantity: 'number' }) },
            ({ sku, quantity }) => {
                handlerArgs.push({ sku, quantity });
                return { content: [{ type: 'text', text: `ordered ${quantity} x ${sku}` }] };
            }
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'submit-order');
    if (!tool) throw new Error('expected submit-order to be listed');
    expect(tool.inputSchema).toMatchObject({
        type: 'object',
        properties: { sku: { type: 'string' }, quantity: { type: 'number' } }
    });
    expect([...(tool.inputSchema.required ?? [])].toSorted()).toEqual(['quantity', 'sku']);

    const r = await client.callTool({ name: 'submit-order', arguments: { sku: 'SKU-1042', quantity: 3 } });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'ordered 3 x SKU-1042' }]);
    expect(handlerArgs).toEqual([{ sku: 'SKU-1042', quantity: 3 }]);
});

verifies('standardschema:tool:valibot-input', async ({ transport }: TestArgs) => {
    // Recorder lives outside the factory so stateless hosting (fresh server per request) shares it.
    const handlerArgs: Array<{ sku: string; quantity: number }> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'restock-item',
            {
                description: 'Restock an item.',
                // The documented valibot path: wrap the schema with @valibot/to-json-schema so JSON Schema can be derived.
                inputSchema: toStandardJsonSchema(v.object({ sku: v.string(), quantity: v.number() }))
            },
            ({ sku, quantity }) => {
                handlerArgs.push({ sku, quantity });
                return { content: [{ type: 'text', text: `restocked ${quantity} x ${sku}` }] };
            }
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === 'restock-item');
    if (!tool) throw new Error('expected restock-item to be listed');
    expect(tool.inputSchema).toMatchObject({
        type: 'object',
        properties: { sku: { type: 'string' }, quantity: { type: 'number' } }
    });
    expect([...(tool.inputSchema.required ?? [])].toSorted()).toEqual(['quantity', 'sku']);

    const r = await client.callTool({ name: 'restock-item', arguments: { sku: 'SKU-7', quantity: 2 } });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'restocked 2 x SKU-7' }]);
    expect(handlerArgs).toEqual([{ sku: 'SKU-7', quantity: 2 }]);
});

verifies('standardschema:tool:invalid-args-rejected', async ({ transport }: TestArgs) => {
    // Counter lives outside the factory so stateless hosting (fresh server per request) shares it.
    const handlerCalls = { n: 0 };
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool(
            'set-thermostat',
            { description: 'Set the target temperature in degrees Celsius.', inputSchema: type({ targetCelsius: 'number' }) },
            ({ targetCelsius }) => {
                handlerCalls.n++;
                return { content: [{ type: 'text', text: `target set to ${targetCelsius}` }] };
            }
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    // Positive control: conforming arguments reach the handler.
    const ok = await client.callTool({ name: 'set-thermostat', arguments: { targetCelsius: 21 } });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toEqual([{ type: 'text', text: 'target set to 21' }]);
    expect(handlerCalls.n).toBe(1);

    // Spec: arguments failing input validation are a JSON-RPC -32602 protocol error, not a tool execution result.
    const invalid = client.callTool({ name: 'set-thermostat', arguments: { targetCelsius: 'warm' } });
    await expect(invalid).rejects.toBeInstanceOf(ProtocolError);
    await expect(invalid).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringMatching(/input validation error/i)
    });
    expect(handlerCalls.n).toBe(1);
});

verifies('standardschema:tool:output-schema-validation', async ({ transport }: TestArgs) => {
    const outputSchema = type({ healthy: 'boolean', uptimeSeconds: 'number' });
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('get-server-status', { inputSchema: type({}), outputSchema }, () => ({
            structuredContent: { healthy: true, uptimeSeconds: 12_345 },
            content: [{ type: 'text', text: JSON.stringify({ healthy: true, uptimeSeconds: 12_345 }) }]
        }));
        s.registerTool(
            'get-server-status-corrupt',
            { inputSchema: type({}), outputSchema },
            // intentionally nonconforming structuredContent (server-side output validation must reject it)
            () => ({ structuredContent: { healthy: 'definitely', uptimeSeconds: 'a while' }, content: [] })
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    // Cold calls (no listTools first) so any validation observed is server-side, not the client's.
    const ok = await client.callTool({ name: 'get-server-status', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toEqual({ healthy: true, uptimeSeconds: 12_345 });

    const corrupt = client.callTool({ name: 'get-server-status-corrupt', arguments: {} });
    await expect(corrupt).rejects.toBeInstanceOf(ProtocolError);
    await expect(corrupt).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringMatching(/output validation error/i)
    });

    // The declaration is real: tools/list advertises the outputSchema derived from the arktype type.
    const { tools } = await client.listTools();
    const corruptTool = tools.find(t => t.name === 'get-server-status-corrupt');
    if (!corruptTool?.outputSchema) throw new Error('expected get-server-status-corrupt to advertise an outputSchema');
    expect(corruptTool.outputSchema).toMatchObject({
        type: 'object',
        properties: { healthy: { type: 'boolean' }, uptimeSeconds: { type: 'number' } }
    });
});

verifies('standardschema:prompt:args-schema', async ({ transport }: TestArgs) => {
    // Recorder lives outside the factory so stateless hosting (fresh server per request) shares it.
    const callbackArgs: Array<{ city: string }> = [];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerPrompt(
            'plan-itinerary',
            { description: 'Plan a one-day itinerary for a city.', argsSchema: type({ city: 'string' }) },
            ({ city }) => {
                callbackArgs.push({ city });
                return { messages: [{ role: 'user', content: { type: 'text', text: `Plan a one-day itinerary for ${city}.` } }] };
            }
        );
        return s;
    };
    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    // prompts/list exposes the argument names derived from the arktype schema.
    const { prompts } = await client.listPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.name).toBe('plan-itinerary');
    expect(prompts[0]?.arguments).toEqual([{ name: 'city', required: true }]);

    const ok = await client.getPrompt({ name: 'plan-itinerary', arguments: { city: 'Lisbon' } });
    expect(ok.messages).toEqual([{ role: 'user', content: { type: 'text', text: 'Plan a one-day itinerary for Lisbon.' } }]);
    expect(callbackArgs).toEqual([{ city: 'Lisbon' }]);

    // Arguments failing the schema are rejected before the callback runs.
    await expect(client.getPrompt({ name: 'plan-itinerary', arguments: {} })).rejects.toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: expect.stringMatching(/invalid arguments for prompt plan-itinerary/i)
    });
    expect(callbackArgs).toEqual([{ city: 'Lisbon' }]);
});
