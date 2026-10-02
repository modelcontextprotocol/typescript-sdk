/**
 * Connects to `./server.ts` and asserts the `com.example/feature-flags`
 * extension capability and its settings are advertised on both the legacy
 * (`--legacy`, 2025 `initialize`) and modern (`server/discover`) legs.
 *
 * Spawns the sibling `server.ts` over stdio by default, or connects to a
 * running endpoint under `--http <url>`. See `examples/CONTRIBUTING.md` for
 * the canonical shape.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();

const client = new Client(
    { name: 'extension-capabilities-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await client.connect(
    transport === 'stdio'
        ? new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] })
        : new StreamableHTTPClientTransport(new URL(url))
);

// Read the negotiated extension map after connecting.
const extensions = client.getServerCapabilities()?.extensions ?? {};
console.log(
    `[client] ${era} leg (${client.getNegotiatedProtocolVersion()}) advertised extensions: ${Object.keys(extensions).join(', ') || '(none)'}`
);

check.ok('com.example/feature-flags' in extensions);
check.deepEqual(extensions['com.example/feature-flags'], { flags: ['dark-mode', 'beta-search'] });

await client.close();
