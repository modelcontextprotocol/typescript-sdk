/**
 * Connects to the Hono-hosted server, lists tools and calls `greet`.
 *
 * HTTP-only — the point is the Hono adapter; a stdio leg would bypass it.
 */
import { check, parseExampleArgs } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { url, era } = parseExampleArgs();

// `createMcpHandler.fetch` serves both eras (default `'stateless'` posture);
// the runner drives `--legacy` to exercise the legacy negotiation path too.
const client = new Client(
    { name: 'hono-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await client.connect(new StreamableHTTPClientTransport(new URL(url)));

const tools = await client.listTools();
check.ok(tools.tools.some(t => t.name === 'greet'));
const result = await client.callTool({ name: 'greet', arguments: { name: 'hono' } });
check.match(result.content?.[0]?.type === 'text' ? result.content[0].text : '', /Hello, hono!/);

await client.close();
