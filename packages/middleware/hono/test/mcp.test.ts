import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { Hono } from 'hono';

import { mcp } from '../src/hono';

function recipeServer(): McpServer {
    const server = new McpServer({ name: 'recipe-server', version: '1.2.0' });
    server.registerTool('get_recipe', { description: 'Returns the preparation steps for a dish.' }, () => ({
        content: [{ type: 'text', text: 'Steps: mix, bake, serve.' }]
    }));
    return server;
}

/**
 * A `fetch` that routes a client request straight into the Hono app in process —
 * no port bound. Localhost `Host`/`Origin` are set so the app's default DNS
 * rebinding protection lets the request through.
 */
function inProcessFetch(app: Hono): (url: string | URL, init?: RequestInit) => Promise<Response> {
    return (url, init) => {
        const request = new Request(url, init);
        request.headers.set('Host', 'localhost');
        request.headers.set('Origin', 'http://localhost');
        return Promise.resolve(app.fetch(request));
    };
}

/** JSON-RPC `initialize` body, for the raw-request DNS rebinding probes. */
function initializeBody(): string {
    return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0.0.1' } }
    });
}

describe('@modelcontextprotocol/hono mcp() middleware', () => {
    test('serves a client over the legacy (2025) stateless path', async () => {
        const app = new Hono();
        app.all('/mcp', mcp(recipeServer));

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: inProcessFetch(app) });

        try {
            await client.connect(transport);
            expect(client.getServerVersion()).toEqual({ name: 'recipe-server', version: '1.2.0' });

            const { tools } = await client.listTools();
            expect(tools.map(t => t.name)).toEqual(['get_recipe']);
        } finally {
            await client.close();
        }
    });

    test('serves a client over the modern (2026-07-28) path', async () => {
        const app = new Hono();
        app.all('/mcp', mcp(recipeServer));

        const client = new Client({ name: 'test-client', version: '1.0.0' });
        client.setVersionNegotiation({ mode: { pin: '2026-07-28' } });
        const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: inProcessFetch(app) });

        try {
            await client.connect(transport);

            const { tools } = await client.listTools();
            expect(tools.map(t => t.name)).toEqual(['get_recipe']);

            const result = await client.callTool({ name: 'get_recipe' });
            expect(result.content).toEqual([{ type: 'text', text: 'Steps: mix, bake, serve.' }]);
        } finally {
            await client.close();
        }
    });

    test('builds a fresh server per request (factory is per-request)', async () => {
        let built = 0;
        const app = new Hono();
        app.all(
            '/mcp',
            mcp(() => {
                built += 1;
                return recipeServer();
            })
        );

        const connect = async () => {
            const client = new Client({ name: 'test-client', version: '1.0.0' });
            const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), { fetch: inProcessFetch(app) });
            await client.connect(transport);
            await client.close();
        };

        await connect();
        await connect();

        // Stateless serving builds one server per request (initialize + listTools
        // during connect count as separate exchanges), so it is strictly > 1.
        expect(built).toBeGreaterThan(1);
    });

    test('arms localhost DNS rebinding protection by default (rejects hostile Host)', async () => {
        const app = new Hono();
        app.all('/mcp', mcp(recipeServer));

        const res = await app.request('http://localhost/mcp', {
            method: 'POST',
            headers: { Host: 'evil.example.com', 'content-type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: initializeBody()
        });

        expect(res.status).toBe(403);
    });

    test('arms localhost origin validation by default (rejects hostile Origin)', async () => {
        const app = new Hono();
        app.all('/mcp', mcp(recipeServer));

        const res = await app.request('http://localhost/mcp', {
            method: 'POST',
            headers: {
                Host: 'localhost:3000',
                Origin: 'http://evil.example.com',
                'content-type': 'application/json',
                Accept: 'application/json, text/event-stream'
            },
            body: initializeBody()
        });

        expect(res.status).toBe(403);
    });

    test('uses allowedHosts / allowedOrigins when provided', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const app = new Hono();
        app.all('/mcp', mcp(recipeServer, { host: '0.0.0.0', allowedHosts: ['myapp.local'], allowedOrigins: ['myapp.local'] }));
        warn.mockRestore();

        const good = await app.request('http://localhost/mcp', {
            method: 'POST',
            headers: {
                Host: 'myapp.local:3000',
                Origin: 'https://myapp.local',
                'content-type': 'application/json',
                Accept: 'application/json, text/event-stream'
            },
            body: initializeBody()
        });
        expect(good.status).toBe(200);

        const bad = await app.request('http://localhost/mcp', {
            method: 'POST',
            headers: { Host: 'evil.example.com', 'content-type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: initializeBody()
        });
        expect(bad.status).toBe(403);
    });
});
