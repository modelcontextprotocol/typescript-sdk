/**
 * `ServerOptions.extensions`: an extension is advertised under
 * `capabilities.extensions[id]` and installed at construction, where it can
 * register custom methods and override spec methods such as `tools/call`.
 */
import type { JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    MissingRequiredClientCapabilityError,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core-internal';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import type { ServerExtension } from '../../src/server/extension';
import { invoke } from '../../src/server/invoke';
import { McpServer } from '../../src/server/mcp';
import { Server } from '../../src/server/server';

const MODERN_REVISION = '2026-07-28';
const MODERN: MessageClassification = { era: 'modern', revision: MODERN_REVISION };
const EXT_ID = 'com.example/gate';

const modernRequest = (
    method: string,
    params: Record<string, unknown> = {},
    clientCapabilities: Record<string, unknown> = {}
): JSONRPCRequest =>
    ({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
            ...params,
            _meta: {
                [PROTOCOL_VERSION_META_KEY]: MODERN_REVISION,
                [CLIENT_INFO_META_KEY]: { name: 'ext-client', version: '1.0.0' },
                [CLIENT_CAPABILITIES_META_KEY]: clientCapabilities
            }
        }
    }) as JSONRPCRequest;

async function exchange(server: Server, request: JSONRPCRequest): Promise<Record<string, unknown>> {
    setNegotiatedProtocolVersion(server, MODERN_REVISION);
    const response = await invoke(server, request, { classification: MODERN });
    return (await response.json()) as Record<string, unknown>;
}

/** An extension that gates `tools/call` on a client capability and adds one custom method. */
function gateExtension(log: string[]): ServerExtension {
    return {
        id: EXT_ID,
        capability: { modes: ['strict'] },
        install(server) {
            log.push('installed');
            server.setRequestHandler('gate/status', { params: z.looseObject({}) }, () => ({ armed: true }));
            server.overrideRequestHandler('tools/call', (request, ctx, next) => {
                const envelope = ctx.mcpReq.envelope as Record<string, Record<string, unknown>> | undefined;
                const extensions = envelope?.[CLIENT_CAPABILITIES_META_KEY]?.['extensions'] as Record<string, unknown> | undefined;
                if (extensions === undefined || !(EXT_ID in extensions)) {
                    throw new MissingRequiredClientCapabilityError(
                        { requiredCapabilities: { extensions: { [EXT_ID]: {} } } },
                        'declare the gate'
                    );
                }
                return next(request, ctx);
            });
        }
    };
}

describe('ServerOptions.extensions', () => {
    it('advertises the extension capability and installs it at construction', () => {
        const log: string[] = [];
        const server = new Server({ name: 's', version: '1' }, { extensions: [gateExtension(log)] });
        expect(log).toEqual(['installed']);
        expect(server.getCapabilities().extensions).toEqual({ [EXT_ID]: { modes: ['strict'] } });
    });

    it('defaults the advertised settings to {} and passes through McpServer', () => {
        const ext: ServerExtension = { id: 'com.example/plain', install: () => {} };
        const mcp = new McpServer({ name: 's', version: '1' }, { extensions: [ext] });
        expect(mcp.server.getCapabilities().extensions).toEqual({ 'com.example/plain': {} });
    });

    it('serves the extension custom method', async () => {
        const server = new Server({ name: 's', version: '1' }, { extensions: [gateExtension([])] });
        const body = await exchange(server, modernRequest('gate/status'));
        expect(body['result']).toMatchObject({ armed: true });
    });

    it('overrides tools/call registered later by McpServer: refuses without the capability, passes through with it', async () => {
        const mcp = new McpServer({ name: 's', version: '1' }, { extensions: [gateExtension([])] });
        mcp.registerTool('echo', { inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
            content: [{ type: 'text', text }]
        }));

        const refused = await exchange(mcp.server, modernRequest('tools/call', { name: 'echo', arguments: { text: 'hi' } }));
        expect(refused['error']).toMatchObject({ code: -32_021, message: 'declare the gate' });

        const allowed = await exchange(
            mcp.server,
            modernRequest('tools/call', { name: 'echo', arguments: { text: 'hi' } }, { extensions: { [EXT_ID]: {} } })
        );
        expect(allowed['result']).toMatchObject({ content: [{ type: 'text', text: 'hi' }] });
    });

    it('a MissingRequiredClientCapabilityError thrown by a tool handler is a JSON-RPC error, not an isError result', async () => {
        const mcp = new McpServer({ name: 's', version: '1' });
        mcp.registerTool('needs-ext', {}, async () => {
            throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [EXT_ID]: {} } } }, 'declare the gate');
        });
        const body = await exchange(mcp.server, modernRequest('tools/call', { name: 'needs-ext', arguments: {} }));
        expect(body['error']).toMatchObject({ code: -32_021, data: { requiredCapabilities: { extensions: { [EXT_ID]: {} } } } });
    });
});
