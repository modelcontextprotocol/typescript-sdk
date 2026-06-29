/**
 * Drives the resources example: list, list templates, read direct + templated.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();

const client = new Client(
    { name: 'resources-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await (transport === 'stdio'
    ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
    : client.connect(new StreamableHTTPClientTransport(new URL(url))));

const list = await client.listResources();
check.ok(list.resources.some(r => r.uri === 'config://app'));

const templates = await client.listResourceTemplates();
check.ok(templates.resourceTemplates.some(t => t.uriTemplate === 'greeting://{name}'));

const config = await client.readResource({ uri: 'config://app' });
const configContent = config.contents[0];
check.equal(configContent && 'text' in configContent ? configContent.text : '', '{"feature":true}');

const hello = await client.readResource({ uri: 'greeting://world' });
const helloContent = hello.contents[0];
check.equal(helloContent && 'text' in helloContent ? helloContent.text : '', 'Hello, world!');

await client.close();
