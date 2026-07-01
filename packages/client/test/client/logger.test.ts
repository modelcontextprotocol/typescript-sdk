import type { JSONRPCRequest, Tool } from '@modelcontextprotocol/core-internal';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '../../src/client/client';

const MODERN = '2026-07-28';

describe('Client logger option', () => {
    it('routes SDK diagnostics to the configured logger', async () => {
        const debug = vi.fn();
        const consoleDebug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const client = new Client({ name: 'test-client', version: '1.0.0' }, { logger: { debug } });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        serverTransport.onmessage = async message => {
            if ('method' in message && 'id' in message && message.method === 'initialize') {
                await serverTransport.send({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: LATEST_PROTOCOL_VERSION,
                        capabilities: {},
                        serverInfo: { name: 'test-server', version: '1.0.0' }
                    }
                });
            }
        };

        await Promise.all([client.connect(clientTransport), serverTransport.start()]);

        await expect(client.listTools()).resolves.toEqual({ tools: [] });
        expect(debug).toHaveBeenCalledWith(
            'Client.listTools() called but server does not advertise tools capability - returning empty list'
        );
        expect(consoleDebug).not.toHaveBeenCalled();

        consoleDebug.mockRestore();
        await client.close();
        await clientTransport.close();
        await serverTransport.close();
    });

    it('routes invalid x-mcp-header tool exclusion warnings to the configured logger', async () => {
        const warn = vi.fn();
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const client = new Client(
            { name: 'test-client', version: '1.0.0' },
            { logger: { warn }, versionNegotiation: { mode: { pin: MODERN } } }
        );
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const invalidTool: Tool = {
            name: 'bad-tool',
            inputSchema: { type: 'object', properties: { data: { type: 'object', 'x-mcp-header': 'Data' } } }
        };

        serverTransport.onmessage = async message => {
            const request = message as JSONRPCRequest;
            if (request.id === undefined) return;

            if (request.method === 'server/discover') {
                await serverTransport.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        resultType: 'complete',
                        supportedVersions: [MODERN],
                        capabilities: { tools: {} },
                        serverInfo: { name: 'test-server', version: '1.0.0' }
                    }
                });
            } else if (request.method === 'tools/list') {
                await serverTransport.send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        resultType: 'complete',
                        ttlMs: 60_000,
                        cacheScope: 'public',
                        tools: [invalidTool]
                    }
                });
            }
        };

        await Promise.all([client.connect(clientTransport), serverTransport.start()]);

        const result = await client.listTools();
        expect(result.tools).toEqual([]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("excluding tool 'bad-tool'"));
        expect(consoleWarn).not.toHaveBeenCalled();

        consoleWarn.mockRestore();
        await client.close();
        await clientTransport.close();
        await serverTransport.close();
    });
});
