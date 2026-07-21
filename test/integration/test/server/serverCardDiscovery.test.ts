/**
 * Server Card discovery end to end: the card and catalog responders composed
 * in front of createMcpHandler on a real HTTP server, walked by
 * discoverServerCards, resolved with resolveRemote, connected with a real
 * client, and reconciled against the live serverInfo.
 */
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { discoverServerCards, reconcileServerCard, resolveRemote } from '@modelcontextprotocol/client/experimental/server-card';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
    aiCatalogResponse,
    buildAICatalog,
    buildServerCard,
    getServerCardUrl,
    serverCardCatalogEntry,
    serverCardResponse
} from '@modelcontextprotocol/server/experimental/server-card';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';

describe('Server Card discovery against a live MCP endpoint', () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    afterEach(async () => {
        while (cleanups.length > 0) await cleanups.pop()!();
    });

    async function startEndpoint(): Promise<{ baseUrl: URL }> {
        const serverInfo = { name: 'com.example/weather', version: '1.2.3' };
        const factory = () => new McpServer(serverInfo, { capabilities: { tools: {} } });
        const handler = createMcpHandler(factory);

        // The card is built lazily on the first request, once the port is known.
        let documents: { card: ReturnType<typeof buildServerCard>; catalog: ReturnType<typeof buildAICatalog>; mcpUrl: URL } | undefined;
        const fetchHandler = async (request: Request): Promise<Response> => {
            if (documents === undefined) {
                const mcpUrl = new URL('/mcp', new URL(request.url).origin);
                const card = buildServerCard({
                    name: 'com.example/weather',
                    description: 'Hourly and 7-day forecasts for any coordinates',
                    serverInfo,
                    remotes: [{ type: 'streamable-http', url: mcpUrl.href }]
                });
                const catalog = buildAICatalog({ entries: [serverCardCatalogEntry(card, { url: getServerCardUrl(mcpUrl) })] });
                documents = { card, catalog, mcpUrl };
            }
            return await (serverCardResponse(request, { card: documents.card, mcpUrl: documents.mcpUrl }) ??
                aiCatalogResponse(request, { catalog: documents.catalog }) ??
                handler.fetch(request));
        };

        const httpServer: HttpServer = createServer(toNodeHandler({ fetch: fetchHandler }));
        const baseUrl = await listenOnRandomPort(httpServer);
        cleanups.push(async () => {
            await handler.close();
            httpServer.close();
        });
        return { baseUrl };
    }

    it('discovers, resolves, connects, and reconciles', async () => {
        const { baseUrl } = await startEndpoint();
        // Loopback endpoint: the local-dev overrides are required and exercised.
        const hits = await discoverServerCards(baseUrl, { allowHttp: true, allowPrivateHosts: true });
        expect(hits).toHaveLength(1);
        const hit = hits[0]!;
        expect(hit.listingDomain).toBe(baseUrl.host);
        expect(hit.hostingDomain).toBe(baseUrl.host);
        expect(hit.card.name).toBe('com.example/weather');

        const remote = hit.card.remotes![0]!;
        const resolved = resolveRemote(remote);
        expect(resolved.url.href).toBe(new URL('/mcp', baseUrl).href);

        const client = new Client({ name: 'discovery-client', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(resolved.url, { requestInit: { headers: resolved.headers } }));
        cleanups.push(() => client.close());

        const serverInfo = client.getServerVersion();
        expect(serverInfo).toBeDefined();
        expect(reconcileServerCard(hit.card, serverInfo!, { remote })).toEqual([]);
    });

    it('returns [] for a host without a catalog', async () => {
        const httpServer: HttpServer = createServer((_req, res) => {
            res.statusCode = 404;
            res.end();
        });
        const baseUrl = await listenOnRandomPort(httpServer);
        cleanups.push(() => {
            httpServer.close();
        });
        await expect(discoverServerCards(baseUrl, { allowHttp: true, allowPrivateHosts: true })).resolves.toEqual([]);
    });
});
