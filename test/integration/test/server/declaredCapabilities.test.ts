import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, ProtocolErrorCode } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, test } from 'vitest';
import * as z from 'zod/v4';

async function connect(mcpServer: McpServer): Promise<Client> {
    const client = new Client({ name: 'test client', version: '1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
    return client;
}

describe('declared capabilities answer list methods (draft spec)', () => {
    /***
     * Test: a server that declares a primitive capability MUST respond to its list method
     * (with an empty result) even if nothing has been registered yet, rather than
     * returning "Method not found".
     */
    test('declared-but-empty tools/resources/prompts capabilities answer list methods with empty arrays', async () => {
        const mcpServer = new McpServer(
            { name: 'test server', version: '1.0' },
            { capabilities: { tools: {}, resources: {}, prompts: {} } }
        );

        const client = await connect(mcpServer);

        await expect(client.listTools()).resolves.toEqual({ tools: [] });
        await expect(client.listResources()).resolves.toEqual({ resources: [] });
        await expect(client.listResourceTemplates()).resolves.toEqual({ resourceTemplates: [] });
        await expect(client.listPrompts()).resolves.toEqual({ prompts: [] });
    });

    /***
     * Test: calling an unknown tool on a declared-but-empty tools capability returns
     * an "Invalid params" error, not "Method not found".
     */
    test('tools/call for an unknown tool returns InvalidParams when tools capability is declared', async () => {
        const mcpServer = new McpServer({ name: 'test server', version: '1.0' }, { capabilities: { tools: {} } });

        const client = await connect(mcpServer);

        await expect(client.callTool({ name: 'nonexistent' })).rejects.toMatchObject({
            code: ProtocolErrorCode.InvalidParams
        });
    });

    /***
     * Test: capabilities that were NOT declared (and have no registrations) still return
     * "Method not found" on the wire. Raw requests are used because the Client's
     * convenience list methods short-circuit locally when the server does not advertise
     * the corresponding capability.
     */
    test('undeclared capabilities still return MethodNotFound', async () => {
        const mcpServer = new McpServer({ name: 'test server', version: '1.0' }, { capabilities: { tools: {} } });

        const client = await connect(mcpServer);

        await expect(client.listTools()).resolves.toEqual({ tools: [] });
        await expect(client.request({ method: 'resources/list' })).rejects.toMatchObject({
            code: ProtocolErrorCode.MethodNotFound
        });
        await expect(client.request({ method: 'prompts/list' })).rejects.toMatchObject({
            code: ProtocolErrorCode.MethodNotFound
        });
    });

    /***
     * Test: a server constructed without declared capabilities behaves as before —
     * list handlers are installed lazily on first registration.
     */
    test('no declared capabilities and no registrations returns MethodNotFound for all list methods', async () => {
        const mcpServer = new McpServer({ name: 'test server', version: '1.0' });

        const client = await connect(mcpServer);

        await expect(client.request({ method: 'tools/list' })).rejects.toMatchObject({
            code: ProtocolErrorCode.MethodNotFound
        });
        await expect(client.request({ method: 'resources/list' })).rejects.toMatchObject({
            code: ProtocolErrorCode.MethodNotFound
        });
        await expect(client.request({ method: 'prompts/list' })).rejects.toMatchObject({
            code: ProtocolErrorCode.MethodNotFound
        });
    });

    /***
     * Test: registering primitives after declaring the capability up front continues to work
     * (the eagerly installed handlers list later registrations).
     */
    test('registrations made after construction are listed by the eagerly installed handlers', async () => {
        const mcpServer = new McpServer({ name: 'test server', version: '1.0' }, { capabilities: { tools: {} } });

        mcpServer.registerTool('greet', { description: 'Greets' }, () => ({
            content: [{ type: 'text', text: 'hi' }]
        }));

        const client = await connect(mcpServer);

        const result = await client.listTools();
        expect(result.tools.map(t => t.name)).toEqual(['greet']);
    });
});

describe('deterministic tools/list ordering (draft spec)', () => {
    /***
     * Test: tools/list SHOULD return tools in a deterministic order when the underlying
     * tool set has not changed. The SDK lists tools in registration (insertion) order.
     */
    test('tools/list returns an identical order across repeated requests', async () => {
        const mcpServer = new McpServer({ name: 'test server', version: '1.0' });

        const names = ['zeta', 'alpha', 'mid', 'omega', 'beta'];
        for (const name of names) {
            mcpServer.registerTool(name, { inputSchema: z.object({ value: z.string() }) }, ({ value }) => ({
                content: [{ type: 'text', text: `${name}:${value}` }]
            }));
        }

        const client = await connect(mcpServer);

        const first = await client.listTools();
        const second = await client.listTools();

        expect(first.tools.map(t => t.name)).toEqual(names);
        expect(second.tools.map(t => t.name)).toEqual(names);
    });

    test('tools/list ordering stays stable across disable/enable toggles', async () => {
        const mcpServer = new McpServer({ name: 'test server', version: '1.0' });

        const names = ['zeta', 'alpha', 'mid', 'omega', 'beta'];
        const registered = names.map(name =>
            mcpServer.registerTool(name, {}, () => ({
                content: [{ type: 'text', text: name }]
            }))
        );

        const client = await connect(mcpServer);

        // Disable a tool in the middle: relative order of the remaining tools is unchanged.
        registered[2].disable();
        const whileDisabled = await client.listTools();
        expect(whileDisabled.tools.map(t => t.name)).toEqual(['zeta', 'alpha', 'omega', 'beta']);

        // Re-enable it: the original insertion order is restored, not appended at the end.
        registered[2].enable();
        const afterReenable = await client.listTools();
        expect(afterReenable.tools.map(t => t.name)).toEqual(names);
    });
});
