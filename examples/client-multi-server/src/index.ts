/**
 * Minimal multi-server routing example.
 *
 * Spawns two in-repo MCP servers (server-quickstart and mcpServerOutputSchema),
 * connects a Client to each, discovers their tools, and routes tool calls to
 * the correct server based on which one registered the tool.
 *
 * Run: npx tsx examples/client-multi-server/src/index.ts
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client, StdioClientTransport } from '@modelcontextprotocol/client';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Each server entry: a name and the path to its stdio entrypoint.
const servers = [
  {
    name: 'weather-nws',
    script: resolve(__dirname, '../../server-quickstart/src/index.ts'),
  },
  {
    name: 'weather-structured',
    script: resolve(__dirname, '../../server/src/mcpServerOutputSchema.ts'),
  },
];

// Maps prefixed tool name -> { client, originalName, serverName }
const toolRouter = new Map<
  string,
  { client: Client; originalName: string; serverName: string }
>();

async function main() {
  const clients: Client[] = [];

  // 1. Connect to each server and discover tools
  for (const { name, script } of servers) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', script],
    });
    const client = new Client({ name: `router-${name}`, version: '1.0.0' });
    await client.connect(transport);
    clients.push(client);

    const { tools } = await client.listTools();
    for (const tool of tools) {
      const prefixed = `${name}__${tool.name}`;
      toolRouter.set(prefixed, {
        client,
        originalName: tool.name,
        serverName: name,
      });
    }

    console.log(`[${name}] connected, tools: ${tools.map((t) => t.name).join(', ')}`);
  }

  console.log(`\nRouting table (${toolRouter.size} tools):`);
  for (const [prefixed, { serverName, originalName }] of toolRouter) {
    console.log(`  ${prefixed} -> ${serverName} (${originalName})`);
  }

  // 2. Demonstrate routing: call one tool from each server
  console.log('\n--- Routing demo ---\n');

  // Call get-alerts from weather-nws (server-quickstart)
  const alertsKey = 'weather-nws__get-alerts';
  const alertsRoute = toolRouter.get(alertsKey);
  if (alertsRoute) {
    console.log(`Calling ${alertsKey} ...`);
    const result = await alertsRoute.client.callTool({
      name: alertsRoute.originalName,
      arguments: { state: 'CA' },
    });
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    console.log(`Result: ${text.slice(0, 200)}...\n`);
  }

  // Call get_weather from weather-structured (mcpServerOutputSchema)
  const weatherKey = 'weather-structured__get_weather';
  const weatherRoute = toolRouter.get(weatherKey);
  if (weatherRoute) {
    console.log(`Calling ${weatherKey} ...`);
    const result = await weatherRoute.client.callTool({
      name: weatherRoute.originalName,
      arguments: { city: 'Seattle', country: 'US' },
    });
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    console.log(`Result: ${text.slice(0, 200)}...\n`);
  }

  // 3. Cleanup
  for (const client of clients) {
    await client.close();
  }
  console.log('All servers disconnected.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
