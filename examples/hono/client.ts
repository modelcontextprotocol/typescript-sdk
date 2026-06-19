/**
 * Connects to the Hono-hosted server, lists tools and calls `greet`.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { check, httpUrlFromArgs, negotiationFromArgs, runClient } from '../harness.js';

const URL = httpUrlFromArgs('http://127.0.0.1:3000/mcp');

runClient('hono', async () => {
    // `createMcpHandler.fetch` serves both eras (default `'stateless'` posture);
    // `negotiationFromArgs()` honours `--legacy` so the harness runs both.
    const client = new Client({ name: 'hono-client', version: '1.0.0' }, { versionNegotiation: negotiationFromArgs() });
    await client.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));
    const tools = await client.listTools();
    check.ok(tools.tools.some(t => t.name === 'greet'));
    const result = await client.callTool({ name: 'greet', arguments: { name: 'hono' } });
    check.match(result.content?.[0]?.type === 'text' ? result.content[0].text : '', /Hello, hono!/);
    await client.close();
});
