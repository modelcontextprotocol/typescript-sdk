/**
 * Initializes with a protocol version the server lists in
 * `supportedProtocolVersions` (and one it does not, to assert the fallback).
 */
import { check, connectFromArgs, runClient } from '../harness.js';

runClient('custom-version', async () => {
    // A plain (2025-handshake) client; the server supports the SDK's stock
    // 2025 version so this negotiates that.
    // connectFromArgs picks transport (default: spawn ./server.ts over stdio; --http <url>) and era (--legacy) from argv. Your code would construct a Client and connect over your chosen transport directly.
    const client = await connectFromArgs(import.meta.dirname, { versionNegotiation: undefined });

    // The server should advertise its supportedProtocolVersions in its
    // tool's text payload.
    const result = await client.callTool({ name: 'get-protocol-info' });
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '{}';
    const info = JSON.parse(text) as { supportedVersions: string[] };
    check.ok(info.supportedVersions.includes('2026-01-01'));
    check.ok(info.supportedVersions.length > 1);

    await client.close();
});
