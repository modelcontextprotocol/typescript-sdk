/**
 * A resource template whose literal text carries characters the URI grammar does not
 * allow — `ucschar` (`café`) or a space — stays routable.
 *
 * `resources/read` resolves the requested URI through `new URL()` before matching, so
 * the template has to line up with the pct-encoded form (RFC 6570 §3.1), whichever form
 * the client sent.
 */
import type { JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';

import { invoke } from '../../src/server/invoke';
import { McpServer, ResourceTemplate } from '../../src/server/mcp';

const MODERN_REVISION = '2026-07-28';
const MODERN: MessageClassification = { era: 'modern', revision: MODERN_REVISION };

const ENVELOPE = {
    [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
    [CLIENT_INFO_META_KEY]: { name: 'literal-encoding-client', version: '1.0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {}
};

const modernRequest = (method: string, params: Record<string, unknown> = {}): JSONRPCRequest =>
    ({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { ...params, _meta: ENVELOPE }
    }) as JSONRPCRequest;

function buildMcpServer(uriTemplate: string): McpServer {
    const mcpServer = new McpServer({ name: 'literal-encoding-server', version: '1.0.0' });
    mcpServer.registerResource('docs', new ResourceTemplate(uriTemplate, { list: undefined }), {}, async (uri, { name }) => ({
        contents: [{ uri: uri.href, text: `contents of ${String(name)}` }]
    }));
    return mcpServer;
}

async function modernBody(uriTemplate: string, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const mcpServer = buildMcpServer(uriTemplate);
    setNegotiatedProtocolVersion(mcpServer.server, MODERN_REVISION);
    const response = await invoke(mcpServer, modernRequest(method, params), { classification: MODERN });
    return (await response.json()) as Record<string, unknown>;
}

describe('a resource template with a non-ASCII literal', () => {
    it('is advertised with the template spelled as registered', async () => {
        const body = (await modernBody('file:///docs/café/{name}', 'resources/templates/list')) as {
            result: { resourceTemplates: { uriTemplate: string }[] };
        };
        expect(body.result.resourceTemplates[0]?.uriTemplate).toBe('file:///docs/café/{name}');
    });

    it.each([
        ['pct-encoded', 'file:///docs/caf%C3%A9/a.txt'],
        ['raw', 'file:///docs/café/a.txt']
    ])('is read when the client sends the %s URI', async (_form, uri) => {
        const body = (await modernBody('file:///docs/café/{name}', 'resources/read', { uri })) as {
            result?: { contents: { uri: string; text: string }[] };
            error?: unknown;
        };
        expect(body.error).toBeUndefined();
        expect(body.result?.contents[0]).toMatchObject({
            uri: 'file:///docs/caf%C3%A9/a.txt',
            text: 'contents of a.txt'
        });
    });

    it('is read when the literal carries a space', async () => {
        const body = (await modernBody('file:///my docs/{name}', 'resources/read', { uri: 'file:///my%20docs/a.txt' })) as {
            result?: { contents: { text: string }[] };
            error?: unknown;
        };
        expect(body.error).toBeUndefined();
        expect(body.result?.contents[0]?.text).toBe('contents of a.txt');
    });
});
