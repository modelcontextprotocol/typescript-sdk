/**
 * Calls each greet variant and asserts every inputSchema published as a JSON
 * Schema with a required `name` string; calls `get-weather` and asserts the
 * structured output matches.
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url, era } = parseExampleArgs();

const client = new Client(
    { name: 'schema-validators-example-client', version: '1.0.0' },
    { versionNegotiation: { mode: era === 'modern' ? 'auto' : 'legacy' } }
);

await (transport === 'stdio'
    ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
    : client.connect(new StreamableHTTPClientTransport(new URL(url))));

const list = await client.listTools();
for (const name of ['greet-zod', 'greet-arktype', 'greet-valibot']) {
    const tool = list.tools.find(t => t.name === name);
    check.ok(tool, `${name} should be listed`);
    const required = (tool!.inputSchema as { required?: string[] }).required ?? [];
    check.ok(required.includes('name'), `${name} inputSchema should require 'name'`);
    const result = await client.callTool({ name, arguments: { name: 'world' } });
    check.match(result.content?.[0]?.type === 'text' ? result.content[0].text : '', /Hello, world!/);
}

// structuredContent is typed `unknown` (SEP-2106). The SDK has already
// runtime-validated it against the server's outputSchema. This client is
// written FOR the paired server above, so the shape is known and a cast is
// the honest known-server idiom (same as C# `.Deserialize<T>()` or Go
// `json.Unmarshal`). A generic host that connects to arbitrary servers
// would not cast; it would render the JSON or narrow at runtime.
const weather = await client.callTool({ name: 'get-weather', arguments: { city: 'Tokyo' } });
const w = weather.structuredContent as { city: string; conditions: string; celsius: number };
check.equal(w.city, 'Tokyo');
check.equal(w.conditions, 'sunny');
check.equal(w.celsius, 21);

// SEP-2106: array structuredContent. The SDK auto-injects a serialized
// JSON text block alongside it. On the legacy era the array is wrapped as
// `{result: <array>}` (the 2025 wire shape only carries object
// structuredContent), so the natural value is at `.result`.
const forecasts = await client.callTool({ name: 'list-forecasts', arguments: { city: 'Tokyo' } });
const text = forecasts.content?.find(c => c.type === 'text');
check.ok(text, 'auto-injected TextContent fallback present');
check.match(text.text, /"hour":"09:00"/);
type Forecast = { hour: string; celsius: number };
if (era === 'legacy') {
    const sc = forecasts.structuredContent as { result: Forecast[] };
    check.equal(sc.result.length, 2);
    check.equal(sc.result[0]?.hour, '09:00');
} else {
    const sc = forecasts.structuredContent as Forecast[];
    check.equal(sc.length, 2);
    check.equal(sc[0]?.hour, '09:00');
}

await client.close();
