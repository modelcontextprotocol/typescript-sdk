import { type Mock } from 'vitest';

import { Client } from '../../src/client/client.js';
import { StreamableHTTPClientTransport } from '../../src/client/streamableHttp.js';

describe('Client Session Recovery', () => {
    let client: Client;
    let transport: StreamableHTTPClientTransport;
    let callLog: string[];

    beforeEach(() => {
        callLog = [];
        client = new Client({ name: 'test-client', version: '1.0.0' });
        transport = new StreamableHTTPClientTransport(new URL('http://localhost:1234/mcp'));
        vi.spyOn(global, 'fetch');
    });

    afterEach(async () => {
        await client.close().catch(() => {});
        vi.clearAllMocks();
    });

    function createFetchMock(scenario: 'recovery' | 'loop' | 'non-session-error') {
        const fetchMock = global.fetch as Mock;

        // Track all calls for debugging
        fetchMock.mockImplementation(async (url: string, options: { body: string }) => {
            const body = options.body ? JSON.parse(options.body) : {};
            const method = body.method || 'unknown';
            const id = body.id;
            callLog.push(`${method}:${id ?? 'notification'}`);

            // Initialize request
            if (method === 'initialize') {
                const sessionId = callLog.filter(c => c.startsWith('initialize')).length === 1 ? 'session-1' : 'session-2';
                return {
                    ok: true,
                    status: 200,
                    headers: new Headers({
                        'content-type': 'application/json',
                        'mcp-session-id': sessionId
                    }),
                    json: () =>
                        Promise.resolve({
                            jsonrpc: '2.0',
                            id,
                            result: {
                                protocolVersion: '2025-03-26',
                                capabilities: {},
                                serverInfo: { name: 'test-server', version: '1.0.0' }
                            }
                        })
                };
            }

            // Notifications (initialized)
            if (method === 'notifications/initialized') {
                return {
                    ok: true,
                    status: 202,
                    headers: new Headers(),
                    body: { cancel: () => Promise.resolve() }
                };
            }

            // Ping request
            if (method === 'ping') {
                const pingCount = callLog.filter(c => c.startsWith('ping')).length;

                if (scenario === 'non-session-error') {
                    // Always return 500 for non-session errors
                    return {
                        ok: false,
                        status: 500,
                        headers: new Headers(),
                        text: () => Promise.resolve('Internal server error')
                    };
                }

                if (scenario === 'loop') {
                    // Always return 404 session error
                    return {
                        ok: false,
                        status: 404,
                        headers: new Headers(),
                        text: () => Promise.resolve('Session not found')
                    };
                }

                // recovery scenario
                if (pingCount === 1) {
                    // First ping fails with 404
                    return {
                        ok: false,
                        status: 404,
                        headers: new Headers(),
                        text: () => Promise.resolve('Session not found')
                    };
                } else {
                    // Second ping succeeds
                    return {
                        ok: true,
                        status: 200,
                        headers: new Headers({ 'content-type': 'application/json' }),
                        json: () =>
                            Promise.resolve({
                                jsonrpc: '2.0',
                                id,
                                result: {}
                            })
                    };
                }
            }

            // Default: return 200 empty
            return {
                ok: true,
                status: 200,
                headers: new Headers({ 'content-type': 'application/json' }),
                json: () =>
                    Promise.resolve({
                        jsonrpc: '2.0',
                        id,
                        result: {}
                    })
            };
        });
    }

    it('should automatically recover from session terminated error', async () => {
        createFetchMock('recovery');

        await client.connect(transport);
        expect(transport.sessionId).toBe('session-1');

        // This should trigger session recovery and succeed
        await client.ping();

        // Should have recovered with new session
        expect(transport.sessionId).toBe('session-2');

        // Verify the key calls happened (there may be additional notifications)
        expect(callLog.filter(c => c.startsWith('initialize'))).toEqual(['initialize:0', 'initialize:2']);
        expect(callLog.filter(c => c.startsWith('ping'))).toEqual(['ping:1', 'ping:3']);
    });

    it('should prevent infinite session recovery loops', async () => {
        createFetchMock('loop');

        await client.connect(transport);

        // Should fail after one recovery attempt
        await expect(client.ping()).rejects.toThrow('Session not found');
    });

    it('should not attempt recovery for non-session errors', async () => {
        createFetchMock('non-session-error');

        await client.connect(transport);

        // Should fail immediately without recovery
        await expect(client.ping()).rejects.toThrow('Internal server error');

        // Only initial connect + one ping call
        expect(callLog.filter(c => c.startsWith('ping')).length).toBe(1);
    });
});
