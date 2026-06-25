import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/core-internal';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '../../src/client/client';

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
});
