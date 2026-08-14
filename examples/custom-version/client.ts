/**
 * Initializes with a protocol version the server lists in
 * `supportedProtocolVersions` (and one it does not, to assert the fallback).
 */
import { check, parseExampleArgs, siblingPath } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const { transport, url } = parseExampleArgs();

// A plain (2025-handshake) client; the server supports the SDK's stock
// 2025 version so this negotiates that.
const client = new Client({ name: 'custom-version-example-client', version: '1.0.0' }, { versionNegotiation: { mode: 'legacy' } });

await (transport === 'stdio'
    ? client.connect(new StdioClientTransport({ command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, 'server.ts')] }))
    : client.connect(new StreamableHTTPClientTransport(new URL(url))));

// The server should advertise its supportedProtocolVersions in its
// tool's text payload.
const result = await client.callTool({ name: 'get-protocol-info' });
const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '{}';
const info = JSON.parse(text) as { supportedVersions: string[] };
check.ok(info.supportedVersions.includes('2026-01-01'));
check.ok(info.supportedVersions.length > 1);

await client.close();
