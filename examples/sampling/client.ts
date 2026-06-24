/**
 * Advertises the sampling capability, registers a `sampling/createMessage`
 * handler that returns a canned summary, then calls the `summarize` tool and
 * asserts the canned text round-tripped.
 *
 * The same handler serves both protocol eras: on the 2025-era leg
 * (`--legacy`) the server pushes `sampling/createMessage` and this handler
 * answers it directly; on the 2026-07-28 leg the auto-fulfilment driver
 * dispatches the embedded `sampling/createMessage` from the server's
 * `inputRequired` result to this same handler, then retries the tool call
 * with the response attached.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();

const client = new Client(
    { name: 'sampling-example-client', version: '1.0.0' },
    {
        versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' },
        capabilities: { sampling: {} }
    }
);

await (transport === 'stdio'
    ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
    : client.connect(new StreamableHTTPClientTransport(new URL(url))));

client.setRequestHandler('sampling/createMessage', async () => ({
    role: 'assistant',
    content: { type: 'text', text: '[canned summary]' },
    model: 'stub',
    stopReason: 'endTurn'
}));

if (transport === 'http' && era === 'legacy') {
    // Push-style `ctx.mcpReq.requestSampling` needs a sessionful return
    // path: the client's response to `sampling/createMessage` is a separate
    // POST that must reach the SAME server instance that sent the request.
    // `createMcpHandler`'s default stateless-legacy posture has no such
    // path — see `../legacy-routing/` for the sessionful `isLegacyRequest`
    // composition. The push-style flow is exercised on stdio/legacy; this
    // leg only verifies the 2025 `initialize` handshake succeeded.
    check.ok(client.getServerCapabilities()?.tools);
} else {
    const result = await client.callTool({ name: 'summarize', arguments: { text: 'hello world' } });
    check.equal(result.content?.[0]?.type === 'text' ? result.content[0].text : '', '[canned summary]');
}

await client.close();
