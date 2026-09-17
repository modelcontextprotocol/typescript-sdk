/**
 * Drives the prompts example: list, complete an argument, get a prompt.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();

const client = new Client(
    { name: 'prompts-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await (transport === 'stdio'
    ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
    : client.connect(new StreamableHTTPClientTransport(new URL(url))));

const list = await client.listPrompts();
check.ok(list.prompts.some(p => p.name === 'review-code'));

const completion = await client.complete({
    ref: { type: 'ref/prompt', name: 'review-code' },
    argument: { name: 'language', value: 'ty' }
});
check.ok(completion.completion.values.includes('typescript'));

const got = await client.getPrompt({ name: 'review-code', arguments: { language: 'rust', code: 'fn main() {}' } });
check.equal(got.messages.length, 1);
const text = got.messages[0]?.content.type === 'text' ? got.messages[0].content.text : '';
check.match(text, /Review this rust code/);

await client.close();
