/**
 * Client for the stateless hello-world server.
 *
 * This is identical to the v1/v2 client pattern — same classes, same `connect()` call.
 * Nothing about the client side changes for users.
 *
 * Run: npx tsx examples/client/src/helloStatelessClient.ts
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'hello-client', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost:3400/mcp')));

const { tools } = await client.listTools();
console.log(
    'Tools:',
    tools.map(t => t.name)
);

const result = await client.callTool({ name: 'greet', arguments: { name: 'world' } });
console.log('Result:', result.content[0]);

await client.close();
