/**
 * Connects to the minimal `createMcpHandler` deployment as both a plain 2025
 * client (`versionNegotiation: { mode: 'legacy' }` — the `initialize`
 * handshake, served stateless from the factory) and a 2026-capable client
 * (`versionNegotiation: { mode: 'auto' }`, served per request). Asserts the
 * same `greet` tool answers identically either way.
 *
 * HTTP-only — `createMcpHandler`'s `legacy: 'stateless'` posture is an HTTP
 * hosting concern; a stdio leg would bypass it. The story body drives BOTH
 * eras itself, so only `url` is read from argv.
 */
import { check, parseExampleArgs } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const { url } = parseExampleArgs();

for (const mode of ['legacy', 'auto'] as const) {
    const client = new Client({ name: 'stateless-legacy-client', version: '1.0.0' }, { versionNegotiation: { mode } });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = await client.listTools();
    check.ok(tools.tools.some(t => t.name === 'greet'));
    const result = await client.callTool({ name: 'greet', arguments: { name: 'world' } });
    check.equal(result.content?.[0]?.type === 'text' ? result.content[0].text : '', 'Hello, world!');
    await client.close();
}
