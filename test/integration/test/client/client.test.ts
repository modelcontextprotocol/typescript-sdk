import { getSupportedElicitationModes } from '@modelcontextprotocol/client';
import type { Prompt, Resource, Tool, Transport } from '@modelcontextprotocol/core';
import {
    InMemoryTransport,
    LATEST_PROTOCOL_VERSION,
    ProtocolErrorCode,
    SdkError,
    SdkErrorCode,
    SUPPORTED_PROTOCOL_VERSIONS
} from '@modelcontextprotocol/core';
import { McpServer, Server } from '@modelcontextprotocol/server';

import { LegacyTestClient } from '../__fixtures__/testClient.js';

/***
 * Test: Initialize with Matching Protocol Version
 */
test('should initialize with matching protocol version', async () => {
    const clientTransport: Transport = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockImplementation(message => {
            if (message.method === 'initialize') {
                clientTransport.onmessage?.({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: LATEST_PROTOCOL_VERSION,
                        capabilities: {},
                        serverInfo: {
                            name: 'test',
                            version: '1.0'
                        },
                        instructions: 'test instructions'
                    }
                });
            }
            return Promise.resolve();
        })
    };

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            }
        }
    );

    await client.connect(clientTransport);

    // Should have sent initialize with latest version
    expect(clientTransport.send).toHaveBeenCalledWith(
        expect.objectContaining({
            method: 'initialize',
            params: expect.objectContaining({
                protocolVersion: LATEST_PROTOCOL_VERSION
            })
        }),
        expect.objectContaining({
            relatedRequestId: undefined
        })
    );

    // Should have the instructions returned
    expect(client.getInstructions()).toEqual('test instructions');
});

/***
 * Test: Initialize with Supported Older Protocol Version
 */
test('should initialize with supported older protocol version', async () => {
    const OLD_VERSION = SUPPORTED_PROTOCOL_VERSIONS[1];
    const clientTransport: Transport = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockImplementation(message => {
            if (message.method === 'initialize') {
                clientTransport.onmessage?.({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: OLD_VERSION,
                        capabilities: {},
                        serverInfo: {
                            name: 'test',
                            version: '1.0'
                        }
                    }
                });
            }
            return Promise.resolve();
        })
    };

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            }
        }
    );

    await client.connect(clientTransport);

    // Connection should succeed with the older version
    expect(client.getServerVersion()).toEqual({
        name: 'test',
        version: '1.0'
    });

    // Expect no instructions
    expect(client.getInstructions()).toBeUndefined();
});

/***
 * Test: Reconnecting with the same Client restores protocol version on new transport
 */
test('should restore negotiated protocol version on transport when reconnecting with same client', async () => {
    const setProtocolVersion = vi.fn();
    const initialTransport: Transport = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        setProtocolVersion,
        send: vi.fn().mockImplementation(message => {
            if (message.method === 'initialize') {
                initialTransport.onmessage?.({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: LATEST_PROTOCOL_VERSION,
                        capabilities: {},
                        serverInfo: { name: 'test', version: '1.0' }
                    }
                });
            }
            return Promise.resolve();
        })
    };

    const client = new LegacyTestClient({ name: 'test client', version: '1.0' });
    await client.connect(initialTransport);

    // Initial handshake should have set the protocol version on the transport
    expect(setProtocolVersion).toHaveBeenCalledWith(LATEST_PROTOCOL_VERSION);
    expect(client.getNegotiatedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION);

    // Now simulate reconnection: new transport with a pre-existing sessionId.
    // connect() will early-return without re-initializing, but MUST restore the protocol version
    // so HTTP transports can keep sending the required mcp-protocol-version header.
    const reconnectSetProtocolVersion = vi.fn();
    const reconnectTransport: Transport = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        setProtocolVersion: reconnectSetProtocolVersion,
        send: vi.fn().mockResolvedValue(undefined),
        sessionId: 'existing-session-id'
    };

    await client.connect(reconnectTransport);

    // No initialize request should have been sent (sessionId was set)
    expect(reconnectTransport.send).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'initialize' }), expect.anything());
    // But the protocol version MUST have been restored onto the new transport
    expect(reconnectSetProtocolVersion).toHaveBeenCalledWith(LATEST_PROTOCOL_VERSION);
});

/***
 * Test: Reject Unsupported Protocol Version
 */
test('should reject unsupported protocol version', async () => {
    const clientTransport: Transport = {
        start: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        send: vi.fn().mockImplementation(message => {
            if (message.method === 'initialize') {
                clientTransport.onmessage?.({
                    jsonrpc: '2.0',
                    id: message.id,
                    result: {
                        protocolVersion: 'invalid-version',
                        capabilities: {},
                        serverInfo: {
                            name: 'test',
                            version: '1.0'
                        }
                    }
                });
            }
            return Promise.resolve();
        })
    };

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            }
        }
    );

    await expect(client.connect(clientTransport)).rejects.toThrow("Server's protocol version is not supported: invalid-version");

    expect(clientTransport.close).toHaveBeenCalled();
});

/***
 * Test: Connect New Client to Old Supported Server Version
 */
test('should connect new client to old, supported server version', async () => {
    const OLD_VERSION = SUPPORTED_PROTOCOL_VERSIONS[1];
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {},
                tools: {}
            }
        }
    );

    server.setRequestHandler('initialize', _request => ({
        protocolVersion: OLD_VERSION,
        capabilities: {
            resources: {},
            tools: {}
        },
        serverInfo: {
            name: 'old server',
            version: '1.0'
        }
    }));

    server.setRequestHandler('resources/list', () => ({
        resources: []
    }));

    server.setRequestHandler('tools/list', () => ({
        tools: []
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new LegacyTestClient(
        {
            name: 'new client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            },
            enforceStrictCapabilities: true
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    expect(client.getServerVersion()).toEqual({
        name: 'old server',
        version: '1.0'
    });
});

/***
 * Test: Version Negotiation with Old Client and Newer Server
 */
test('should negotiate version when client is old, and newer server supports its version', async () => {
    const server = new Server(
        {
            name: 'new server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {},
                tools: {}
            }
        }
    );

    server.setRequestHandler('initialize', _request => ({
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {
            resources: {},
            tools: {}
        },
        serverInfo: {
            name: 'new server',
            version: '1.0'
        }
    }));

    server.setRequestHandler('resources/list', () => ({
        resources: []
    }));

    server.setRequestHandler('tools/list', () => ({
        tools: []
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new LegacyTestClient(
        {
            name: 'old client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            },
            enforceStrictCapabilities: true
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    expect(client.getServerVersion()).toEqual({
        name: 'new server',
        version: '1.0'
    });
});

/***
 * Test: Throw when Old Client and Server Version Mismatch
 */
test("should throw when client is old, and server doesn't support its version", async () => {
    const FUTURE_VERSION = 'FUTURE_VERSION';
    const server = new Server(
        {
            name: 'new server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {},
                tools: {}
            }
        }
    );

    server.setRequestHandler('initialize', _request => ({
        protocolVersion: FUTURE_VERSION,
        capabilities: {
            resources: {},
            tools: {}
        },
        serverInfo: {
            name: 'new server',
            version: '1.0'
        }
    }));

    server.setRequestHandler('resources/list', () => ({
        resources: []
    }));

    server.setRequestHandler('tools/list', () => ({
        tools: []
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new LegacyTestClient(
        {
            name: 'old client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            },
            enforceStrictCapabilities: true
        }
    );

    await Promise.all([
        expect(client.connect(clientTransport)).rejects.toThrow("Server's protocol version is not supported: FUTURE_VERSION"),
        server.connect(serverTransport)
    ]);
});

/***
 * Test: Respect Server Capabilities
 */
test('should respect server capabilities', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {},
                tools: {}
            }
        }
    );

    server.setRequestHandler('initialize', _request => ({
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {
            resources: {},
            tools: {}
        },
        serverInfo: {
            name: 'test',
            version: '1.0'
        }
    }));

    server.setRequestHandler('resources/list', () => ({
        resources: []
    }));

    server.setRequestHandler('tools/list', () => ({
        tools: []
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            },
            enforceStrictCapabilities: true
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Server supports resources and tools, but not prompts
    expect(client.getServerCapabilities()).toEqual({
        resources: {},
        tools: {}
    });

    // These should work
    await expect(client.listResources()).resolves.not.toThrow();
    await expect(client.listTools()).resolves.not.toThrow();

    // These should throw because prompts, logging, and completions are not supported
    await expect(client.listPrompts()).rejects.toThrow('Server does not support prompts');
    await expect(client.setLoggingLevel('error')).rejects.toThrow('Server does not support logging');
    await expect(
        client.complete({
            ref: { type: 'ref/prompt', name: 'test' },
            argument: { name: 'test', value: 'test' }
        })
    ).rejects.toThrow('Server does not support completions');
});

/***
 * Test: Return empty lists for missing capabilities (default behavior)
 * When enforceStrictCapabilities is not set (default), list methods should
 * return empty lists instead of sending requests to servers that don't
 * advertise those capabilities.
 */
test('should return empty lists for missing capabilities by default', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                // Server only supports tools - no prompts or resources
                tools: {}
            }
        }
    );

    server.setRequestHandler('initialize', _request => ({
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {
            tools: {}
        },
        serverInfo: {
            name: 'test',
            version: '1.0'
        }
    }));

    server.setRequestHandler('tools/list', () => ({
        tools: [{ name: 'test-tool', inputSchema: { type: 'object' } }]
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Client with default settings (enforceStrictCapabilities not set)
    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Server only supports tools
    expect(client.getServerCapabilities()).toEqual({
        tools: {}
    });

    // listTools should work and return actual tools
    const toolsResult = await client.listTools();
    expect(toolsResult.tools).toHaveLength(1);
    expect(toolsResult.tools[0]!.name).toBe('test-tool');

    // listPrompts should return empty list without sending request
    const promptsResult = await client.listPrompts();
    expect(promptsResult.prompts).toEqual([]);

    // listResources should return empty list without sending request
    const resourcesResult = await client.listResources();
    expect(resourcesResult.resources).toEqual([]);

    // listResourceTemplates should return empty list without sending request
    const templatesResult = await client.listResourceTemplates();
    expect(templatesResult.resourceTemplates).toEqual([]);
});

/***
 * Test: Respect Client Notification Capabilities
 */
test('should respect client notification capabilities', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                roots: {
                    listChanged: true
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // This should work because the client has the roots.listChanged capability
    await expect(client.legacy.sendRootsListChanged()).resolves.not.toThrow();

    // Create a new client without the roots.listChanged capability
    const clientWithoutCapability = new LegacyTestClient(
        {
            name: 'test client without capability',
            version: '1.0'
        },
        {
            capabilities: {},
            enforceStrictCapabilities: true
        }
    );

    await clientWithoutCapability.connect(clientTransport);

    // This should throw because the client doesn't have the roots.listChanged capability
    await expect(clientWithoutCapability.legacy.sendRootsListChanged()).rejects.toThrow(/^Client does not support/);
});

/***
 * Test: Respect Server Notification Capabilities
 */
test('should respect server notification capabilities', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                logging: {},
                resources: {
                    listChanged: true
                }
            }
        }
    );

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // These should work because the server has the corresponding capabilities
    await expect(server.legacy.sendLoggingMessage({ level: 'info', data: 'Test' })).resolves.not.toThrow();
    await expect(server.sendResourceListChanged()).resolves.not.toThrow();

    // This should throw because the server doesn't have the tools capability
    await expect(server.sendToolListChanged()).rejects.toThrow('Server does not support notifying of tool list changes');
});

/***
 * Test: Only Allow setRequestHandler for Declared Capabilities
 */
test('should only allow setRequestHandler for declared capabilities', () => {
    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                sampling: {}
            }
        }
    );

    // This should work because sampling is a declared capability
    expect(() => {
        client.setRequestHandler('sampling/createMessage', () => ({
            model: 'test-model',
            role: 'assistant',
            content: {
                type: 'text',
                text: 'Test response'
            }
        }));
    }).not.toThrow();

    // This should throw because roots listing is not a declared capability
    expect(() => {
        client.setRequestHandler('roots/list', () => ({}));
    }).toThrow('Client does not support roots capability');
});

test('should allow setRequestHandler for declared elicitation capability', () => {
    const client = new LegacyTestClient(
        {
            name: 'test-client',
            version: '1.0.0'
        },
        {
            capabilities: {
                elicitation: {}
            }
        }
    );

    // This should work because elicitation is a declared capability
    expect(() => {
        client.setRequestHandler('elicitation/create', () => ({
            action: 'accept',
            content: {
                username: 'test-user',
                confirmed: true
            }
        }));
    }).not.toThrow();

    // This should throw because sampling is not a declared capability
    expect(() => {
        client.setRequestHandler('sampling/createMessage', () => ({
            model: 'test-model',
            role: 'assistant',
            content: {
                type: 'text',
                text: 'Test response'
            }
        }));
    }).toThrow('Client does not support sampling capability');
});

test('should accept form-mode elicitation request when client advertises empty elicitation object (back-compat)', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            }
        }
    );

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                elicitation: {}
            }
        }
    );

    // Set up client handler for form-mode elicitation
    client.setRequestHandler('elicitation/create', request => {
        expect(request.params.mode).toBe('form');
        return {
            action: 'accept',
            content: {
                username: 'test-user',
                confirmed: true
            }
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Server should be able to send form-mode elicitation request
    // This works because getSupportedElicitationModes defaults to form mode
    // when neither form nor url are explicitly declared
    const result = await server.legacy.elicitInput({
        mode: 'form',
        message: 'Please provide your username',
        requestedSchema: {
            type: 'object',
            properties: {
                username: {
                    type: 'string',
                    title: 'Username',
                    description: 'Your username'
                },
                confirmed: {
                    type: 'boolean',
                    title: 'Confirm',
                    description: 'Please confirm',
                    default: false
                }
            },
            required: ['username']
        }
    });

    expect(result.action).toBe('accept');
    expect(result.content).toEqual({
        username: 'test-user',
        confirmed: true
    });
});

test('should reject form-mode elicitation when client only supports URL mode', async () => {
    const client = new LegacyTestClient(
        {
            name: 'test-client',
            version: '1.0.0'
        },
        {
            capabilities: {
                elicitation: {
                    url: {}
                }
            }
        }
    );

    const handler = vi.fn().mockResolvedValue({
        action: 'cancel'
    });
    client.setRequestHandler('elicitation/create', handler);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    let resolveResponse: ((message: unknown) => void) | undefined;
    const responsePromise = new Promise<unknown>(resolve => {
        resolveResponse = resolve;
    });

    serverTransport.onmessage = async message => {
        if ('method' in message) {
            if (message.method === 'initialize') {
                if (!('id' in message) || message.id === undefined) {
                    throw new Error('Expected initialize request to include an id');
                }
                const messageId = message.id;
                await serverTransport.send({
                    jsonrpc: '2.0',
                    id: messageId,
                    result: {
                        protocolVersion: LATEST_PROTOCOL_VERSION,
                        capabilities: {},
                        serverInfo: {
                            name: 'test-server',
                            version: '1.0.0'
                        }
                    }
                });
            } else if (message.method === 'notifications/initialized') {
                // ignore
            }
        } else {
            resolveResponse?.(message);
        }
    };

    await client.connect(clientTransport);

    // Server shouldn't send this, because the client capabilities
    // only advertised URL mode. Test that it's rejected by the client:
    const requestId = 1;
    await serverTransport.send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'elicitation/create',
        params: {
            mode: 'form',
            message: 'Provide your username',
            requestedSchema: {
                type: 'object',
                properties: {
                    username: {
                        type: 'string'
                    }
                }
            }
        }
    });

    const response = (await responsePromise) as { id: number; error: { code: number; message: string } };

    expect(response.id).toBe(requestId);
    expect(response.error.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(response.error.message).toContain('Client does not support form-mode elicitation requests');
    expect(handler).not.toHaveBeenCalled();

    await client.close();
});

test('should reject missing-mode elicitation when client only supports URL mode', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                elicitation: {
                    url: {}
                }
            }
        }
    );

    const handler = vi.fn().mockResolvedValue({
        action: 'cancel'
    });
    client.setRequestHandler('elicitation/create', handler);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    await expect(
        server.legacy.request({
            method: 'elicitation/create',
            params: {
                message: 'Please provide data',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        username: {
                            type: 'string'
                        }
                    }
                }
            }
        })
    ).rejects.toThrow('Client does not support form-mode elicitation requests');

    expect(handler).not.toHaveBeenCalled();

    await Promise.all([client.close(), server.close()]);
});

test('should reject URL-mode elicitation when client only supports form mode', async () => {
    const client = new LegacyTestClient(
        {
            name: 'test-client',
            version: '1.0.0'
        },
        {
            capabilities: {
                elicitation: {
                    form: {}
                }
            }
        }
    );

    const handler = vi.fn().mockResolvedValue({
        action: 'cancel'
    });
    client.setRequestHandler('elicitation/create', handler);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    let resolveResponse: ((message: unknown) => void) | undefined;
    const responsePromise = new Promise<unknown>(resolve => {
        resolveResponse = resolve;
    });

    serverTransport.onmessage = async message => {
        if ('method' in message) {
            if (message.method === 'initialize') {
                if (!('id' in message) || message.id === undefined) {
                    throw new Error('Expected initialize request to include an id');
                }
                const messageId = message.id;
                await serverTransport.send({
                    jsonrpc: '2.0',
                    id: messageId,
                    result: {
                        protocolVersion: LATEST_PROTOCOL_VERSION,
                        capabilities: {},
                        serverInfo: {
                            name: 'test-server',
                            version: '1.0.0'
                        }
                    }
                });
            } else if (message.method === 'notifications/initialized') {
                // ignore
            }
        } else {
            resolveResponse?.(message);
        }
    };

    await client.connect(clientTransport);

    // Server shouldn't send this, because the client capabilities
    // only advertised form mode. Test that it's rejected by the client:
    const requestId = 2;
    await serverTransport.send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'elicitation/create',
        params: {
            mode: 'url',
            message: 'Open the authorization page',
            elicitationId: 'elicitation-123',
            url: 'https://example.com/authorize'
        }
    });

    const response = (await responsePromise) as { id: number; error: { code: number; message: string } };

    expect(response.id).toBe(requestId);
    expect(response.error.code).toBe(ProtocolErrorCode.InvalidParams);
    expect(response.error.message).toContain('Client does not support URL-mode elicitation requests');
    expect(handler).not.toHaveBeenCalled();

    await client.close();
});

test('should apply defaults for form-mode elicitation when applyDefaults is enabled', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                prompts: {},
                resources: {},
                tools: {},
                logging: {}
            }
        }
    );

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {
                elicitation: {
                    form: {
                        applyDefaults: true
                    }
                }
            }
        }
    );

    client.setRequestHandler('elicitation/create', request => {
        expect(request.params.mode).toBe('form');
        return {
            action: 'accept',
            content: {}
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result = await server.legacy.elicitInput({
        mode: 'form',
        message: 'Please confirm your preferences',
        requestedSchema: {
            type: 'object',
            properties: {
                confirmed: {
                    type: 'boolean',
                    default: true
                }
            }
        }
    });

    expect(result.action).toBe('accept');
    expect(result.content).toEqual({
        confirmed: true
    });

    await client.close();
});

/***
 * Test: Handle Client Cancelling a Request
 */
test('should handle client cancelling a request', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {}
            }
        }
    );

    // Set up server to delay responding to listResources
    server.setRequestHandler('resources/list', async () => {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return {
            resources: []
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Set up abort controller
    const controller = new AbortController();

    // Issue request but cancel it immediately
    const listResourcesPromise = client.listResources(undefined, {
        signal: controller.signal
    });
    controller.abort('Cancelled by test');

    // Request should be rejected with an SdkError (local timeout/cancellation)
    await expect(listResourcesPromise).rejects.toThrow(SdkError);
});

/***
 * Test: Handle Request Timeout
 */
test('should handle request timeout', async () => {
    const server = new Server(
        {
            name: 'test server',
            version: '1.0'
        },
        {
            capabilities: {
                resources: {}
            }
        }
    );

    // Set up server with a delayed response
    server.setRequestHandler('resources/list', async (_request, ctx) => {
        const timer = new Promise(resolve => {
            const timeout = setTimeout(resolve, 100);
            ctx.mcpReq.signal.addEventListener('abort', () => clearTimeout(timeout));
        });

        await timer;
        return {
            resources: []
        };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new LegacyTestClient(
        {
            name: 'test client',
            version: '1.0'
        },
        {
            capabilities: {}
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Request with 0 msec timeout should fail immediately
    await expect(client.listResources(undefined, { timeout: 0 })).rejects.toMatchObject({
        code: SdkErrorCode.RequestTimeout
    });
});

/***
 * Test: Handle Tool List Changed Notifications with Auto Refresh
 */
test('should handle tool list changed notification with auto refresh', async () => {
    // List changed notifications
    const notifications: [Error | null, Tool[] | null][] = [];

    const server = new McpServer({
        name: 'test-server',
        version: '1.0.0'
    });

    // Register initial tool to enable the tools capability
    server.registerTool(
        'initial-tool',
        {
            description: 'Initial tool'
        },
        async () => ({ content: [] })
    );

    // Configure listChanged handler in constructor
    const client = new LegacyTestClient(
        {
            name: 'test-client',
            version: '1.0.0'
        },
        {
            listChanged: {
                tools: {
                    onChanged: (err, tools) => {
                        notifications.push([err, tools]);
                    }
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result1 = await client.listTools();
    expect(result1.tools).toHaveLength(1);

    // Register another tool - this triggers listChanged notification
    server.registerTool(
        'test-tool',
        {
            description: 'A test tool'
        },
        async () => ({ content: [] })
    );

    // Wait for the debounced notifications to be processed
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Should be 1 notification with 2 tools because autoRefresh is true
    expect(notifications).toHaveLength(1);
    expect(notifications[0]![0]).toBeNull();
    expect(notifications[0]![1]).toHaveLength(2);
    expect(notifications[0]![1]?.[1]!.name).toBe('test-tool');
});

/***
 * Test: Handle Tool List Changed Notifications with Manual Refresh
 */
test('should handle tool list changed notification with manual refresh', async () => {
    // List changed notifications
    const notifications: [Error | null, Tool[] | null][] = [];

    const server = new McpServer({
        name: 'test-server',
        version: '1.0.0'
    });

    // Register initial tool to enable the tools capability
    server.registerTool('initial-tool', {}, async () => ({ content: [] }));

    // Configure listChanged handler with manual refresh (autoRefresh: false)
    const client = new LegacyTestClient(
        {
            name: 'test-client',
            version: '1.0.0'
        },
        {
            listChanged: {
                tools: {
                    autoRefresh: false,
                    debounceMs: 0,
                    onChanged: (err, tools) => {
                        notifications.push([err, tools]);
                    }
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result1 = await client.listTools();
    expect(result1.tools).toHaveLength(1);

    // Register another tool - this triggers listChanged notification
    server.registerTool(
        'test-tool',
        {
            description: 'A test tool'
        },
        async () => ({ content: [] })
    );

    // Wait for the notifications to be processed (no debounce)
    await new Promise(resolve => setTimeout(resolve, 100));

    // Should be 1 notification with no tool data because autoRefresh is false
    expect(notifications).toHaveLength(1);
    expect(notifications[0]![0]).toBeNull();
    expect(notifications[0]![1]).toBeNull();
});

/***
 * Test: Handle Prompt List Changed Notifications
 */
test('should handle prompt list changed notification with auto refresh', async () => {
    const notifications: [Error | null, Prompt[] | null][] = [];

    const server = new McpServer({
        name: 'test-server',
        version: '1.0.0'
    });

    // Register initial prompt to enable the prompts capability
    server.registerPrompt(
        'initial-prompt',
        {
            description: 'Initial prompt'
        },
        async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }]
        })
    );

    // Configure listChanged handler in constructor
    const client = new LegacyTestClient(
        {
            name: 'test-client',
            version: '1.0.0'
        },
        {
            listChanged: {
                prompts: {
                    onChanged: (err, prompts) => {
                        notifications.push([err, prompts]);
                    }
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result1 = await client.listPrompts();
    expect(result1.prompts).toHaveLength(1);

    // Register another prompt - this triggers listChanged notification
    server.registerPrompt('test-prompt', { description: 'A test prompt' }, async () => ({
        messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }]
    }));

    // Wait for the debounced notifications to be processed
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Should be 1 notification with 2 prompts because autoRefresh is true
    expect(notifications).toHaveLength(1);
    expect(notifications[0]![0]).toBeNull();
    expect(notifications[0]![1]).toHaveLength(2);
    expect(notifications[0]![1]?.[1]!.name).toBe('test-prompt');
});

/***
 * Test: Handle Resource List Changed Notifications
 */
test('should handle resource list changed notification with auto refresh', async () => {
    const notifications: [Error | null, Resource[] | null][] = [];

    const server = new McpServer({
        name: 'test-server',
        version: '1.0.0'
    });

    // Register initial resource to enable the resources capability
    server.registerResource('initial-resource', 'file:///initial.txt', {}, async () => ({
        contents: [{ uri: 'file:///initial.txt', text: 'Hello' }]
    }));

    // Configure listChanged handler in constructor
    const client = new LegacyTestClient(
        {
            name: 'test-client',
            version: '1.0.0'
        },
        {
            listChanged: {
                resources: {
                    onChanged: (err, resources) => {
                        notifications.push([err, resources]);
                    }
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const result1 = await client.listResources();
    expect(result1.resources).toHaveLength(1);

    // Register another resource - this triggers listChanged notification
    server.registerResource('test-resource', 'file:///test.txt', {}, async () => ({
        contents: [{ uri: 'file:///test.txt', text: 'Hello' }]
    }));

    // Wait for the debounced notifications to be processed
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Should be 1 notification with 2 resources because autoRefresh is true
    expect(notifications).toHaveLength(1);
    expect(notifications[0]![0]).toBeNull();
    expect(notifications[0]![1]).toHaveLength(2);
    expect(notifications[0]![1]?.[1]!.name).toBe('test-resource');
});

/***
 * Test: Handle Multiple List Changed Handlers
 */
test('should handle multiple list changed handlers configured together', async () => {
    const toolNotifications: [Error | null, Tool[] | null][] = [];
    const promptNotifications: [Error | null, Prompt[] | null][] = [];

    const server = new McpServer({
        name: 'test-server',
        version: '1.0.0'
    });

    // Register initial tool and prompt to enable capabilities
    server.registerTool(
        'tool-1',
        {
            description: 'Tool 1'
        },
        async () => ({ content: [] })
    );
    server.registerPrompt(
        'prompt-1',
        {
            description: 'Prompt 1'
        },
        async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }]
        })
    );

    // Configure multiple listChanged handlers in constructor
    const client = new LegacyTestClient(
        {
            name: 'test-client',
            version: '1.0.0'
        },
        {
            listChanged: {
                tools: {
                    debounceMs: 0,
                    onChanged: (err, tools) => {
                        toolNotifications.push([err, tools]);
                    }
                },
                prompts: {
                    debounceMs: 0,
                    onChanged: (err, prompts) => {
                        promptNotifications.push([err, prompts]);
                    }
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Register another tool and prompt to trigger notifications
    server.registerTool(
        'tool-2',
        {
            description: 'Tool 2'
        },
        async () => ({ content: [] })
    );
    server.registerPrompt(
        'prompt-2',
        {
            description: 'Prompt 2'
        },
        async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }]
        })
    );

    // Wait for notifications to be processed
    await new Promise(resolve => setTimeout(resolve, 100));

    // Both handlers should have received their respective notifications
    expect(toolNotifications).toHaveLength(1);
    expect(toolNotifications[0]![1]).toHaveLength(2);

    expect(promptNotifications).toHaveLength(1);
    expect(promptNotifications[0]![1]).toHaveLength(2);
});

/***
 * Test: Handler not activated when server doesn't advertise listChanged capability
 */
test('should not activate listChanged handler when server does not advertise capability', async () => {
    const notifications: [Error | null, Tool[] | null][] = [];

    // Server with tools capability but WITHOUT listChanged
    const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler('initialize', async request => ({
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} }, // No listChanged: true
        serverInfo: { name: 'test-server', version: '1.0.0' }
    }));

    server.setRequestHandler('tools/list', async () => ({
        tools: [{ name: 'test-tool', inputSchema: { type: 'object' } }]
    }));

    // Configure listChanged handler that should NOT be activated
    const client = new LegacyTestClient(
        { name: 'test-client', version: '1.0.0' },
        {
            listChanged: {
                tools: {
                    debounceMs: 0,
                    onChanged: (err, tools) => {
                        notifications.push([err, tools]);
                    }
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Verify server doesn't have tools.listChanged capability
    expect(client.getServerCapabilities()?.tools?.listChanged).toBeFalsy();

    // Send a tool list changed notification manually
    await server.legacy.notification({ method: 'notifications/tools/list_changed' });
    await new Promise(resolve => setTimeout(resolve, 100));

    // Handler should NOT have been activated because server didn't advertise listChanged
    expect(notifications).toHaveLength(0);
});

/***
 * Test: Handler activated when server advertises listChanged capability
 */
test('should activate listChanged handler when server advertises capability', async () => {
    const notifications: [Error | null, Tool[] | null][] = [];

    // Server with tools.listChanged: true capability
    const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });

    server.setRequestHandler('initialize', async request => ({
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'test-server', version: '1.0.0' }
    }));

    server.setRequestHandler('tools/list', async () => ({
        tools: [{ name: 'test-tool', inputSchema: { type: 'object' } }]
    }));

    // Configure listChanged handler that SHOULD be activated
    const client = new LegacyTestClient(
        { name: 'test-client', version: '1.0.0' },
        {
            listChanged: {
                tools: {
                    debounceMs: 0,
                    onChanged: (err, tools) => {
                        notifications.push([err, tools]);
                    }
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Verify server has tools.listChanged capability
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);

    // Send a tool list changed notification
    await server.legacy.notification({ method: 'notifications/tools/list_changed' });
    await new Promise(resolve => setTimeout(resolve, 100));

    // Handler SHOULD have been called
    expect(notifications).toHaveLength(1);
    expect(notifications[0]![0]).toBeNull();
    expect(notifications[0]![1]).toHaveLength(1);
});

/***
 * Test: No handlers activated when server has no listChanged capabilities
 */
test('should not activate any handlers when server has no listChanged capabilities', async () => {
    const toolNotifications: [Error | null, Tool[] | null][] = [];
    const promptNotifications: [Error | null, Prompt[] | null][] = [];
    const resourceNotifications: [Error | null, Resource[] | null][] = [];

    // Server with capabilities but NO listChanged for any
    const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });

    server.setRequestHandler('initialize', async request => ({
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: 'test-server', version: '1.0.0' }
    }));

    // Configure listChanged handlers for all three types
    const client = new LegacyTestClient(
        { name: 'test-client', version: '1.0.0' },
        {
            listChanged: {
                tools: {
                    debounceMs: 0,
                    onChanged: (err, tools) => toolNotifications.push([err, tools])
                },
                prompts: {
                    debounceMs: 0,
                    onChanged: (err, prompts) => promptNotifications.push([err, prompts])
                },
                resources: {
                    debounceMs: 0,
                    onChanged: (err, resources) => resourceNotifications.push([err, resources])
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Verify server has no listChanged capabilities
    const caps = client.getServerCapabilities();
    expect(caps?.tools?.listChanged).toBeFalsy();
    expect(caps?.prompts?.listChanged).toBeFalsy();
    expect(caps?.resources?.listChanged).toBeFalsy();

    // Send notifications for all three types
    await server.legacy.notification({ method: 'notifications/tools/list_changed' });
    await server.legacy.notification({ method: 'notifications/prompts/list_changed' });
    await server.legacy.notification({ method: 'notifications/resources/list_changed' });
    await new Promise(resolve => setTimeout(resolve, 100));

    // No handlers should have been activated
    expect(toolNotifications).toHaveLength(0);
    expect(promptNotifications).toHaveLength(0);
    expect(resourceNotifications).toHaveLength(0);
});

/***
 * Test: Partial capability support - some handlers activated, others not
 */
test('should handle partial listChanged capability support', async () => {
    const toolNotifications: [Error | null, Tool[] | null][] = [];
    const promptNotifications: [Error | null, Prompt[] | null][] = [];

    // Server with tools.listChanged: true but prompts without listChanged
    const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: { listChanged: true }, prompts: {} } });

    server.setRequestHandler('initialize', async request => ({
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: { listChanged: true }, prompts: {} },
        serverInfo: { name: 'test-server', version: '1.0.0' }
    }));

    server.setRequestHandler('tools/list', async () => ({
        tools: [{ name: 'tool-1', inputSchema: { type: 'object' } }]
    }));

    server.setRequestHandler('prompts/list', async () => ({
        prompts: [{ name: 'prompt-1' }]
    }));

    const client = new LegacyTestClient(
        { name: 'test-client', version: '1.0.0' },
        {
            listChanged: {
                tools: {
                    debounceMs: 0,
                    onChanged: (err, tools) => toolNotifications.push([err, tools])
                },
                prompts: {
                    debounceMs: 0,
                    onChanged: (err, prompts) => promptNotifications.push([err, prompts])
                }
            }
        }
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // Verify capability state
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect(client.getServerCapabilities()?.prompts?.listChanged).toBeFalsy();

    // Send notifications for both
    await server.legacy.notification({ method: 'notifications/tools/list_changed' });
    await server.legacy.notification({ method: 'notifications/prompts/list_changed' });
    await new Promise(resolve => setTimeout(resolve, 100));

    // Tools handler should have been called
    expect(toolNotifications).toHaveLength(1);
    // Prompts handler should NOT have been called (no prompts.listChanged)
    expect(promptNotifications).toHaveLength(0);
});

describe('outputSchema validation', () => {
    /***
     * Test: Validate structuredContent Against outputSchema
     */
    test('should validate structuredContent against outputSchema', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler('initialize', async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler('tools/list', async () => ({
            tools: [
                {
                    name: 'test-tool',
                    description: 'A test tool',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            result: { type: 'string' },
                            count: { type: 'number' }
                        },
                        required: ['result', 'count'],
                        additionalProperties: false
                    }
                }
            ]
        }));

        server.setRequestHandler('tools/call', async request => {
            if (request.params.name === 'test-tool') {
                return {
                    structuredContent: { result: 'success', count: 42 }
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new LegacyTestClient(
            {
                name: 'test-client',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            },
                            tasks: {
                                get: true,
                                list: {},
                                result: true
                            }
                        }
                    }
                }
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should validate successfully
        const result = await client.callTool({ name: 'test-tool' });
        expect(result.structuredContent).toEqual({ result: 'success', count: 42 });
    });

    /***
     * Test: Throw Error when structuredContent Does Not Match Schema
     */
    test('should throw error when structuredContent does not match schema', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler('initialize', async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler('tools/list', async () => ({
            tools: [
                {
                    name: 'test-tool',
                    description: 'A test tool',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            result: { type: 'string' },
                            count: { type: 'number' }
                        },
                        required: ['result', 'count'],
                        additionalProperties: false
                    }
                }
            ]
        }));

        server.setRequestHandler('tools/call', async request => {
            if (request.params.name === 'test-tool') {
                // Return invalid structured content (count is string instead of number)
                return {
                    structuredContent: { result: 'success', count: 'not a number' }
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new LegacyTestClient(
            {
                name: 'test-client',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            },
                            tasks: {
                                get: true,
                                list: {},
                                result: true
                            }
                        }
                    }
                }
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should throw validation error
        await expect(client.callTool({ name: 'test-tool' })).rejects.toThrow(/Structured content does not match the tool's output schema/);
    });

    /***
     * Test: Throw Error when Tool with outputSchema Returns No structuredContent
     */
    test('should throw error when tool with outputSchema returns no structuredContent', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler('initialize', async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler('tools/list', async () => ({
            tools: [
                {
                    name: 'test-tool',
                    description: 'A test tool',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            result: { type: 'string' }
                        },
                        required: ['result']
                    }
                }
            ]
        }));

        server.setRequestHandler('tools/call', async request => {
            if (request.params.name === 'test-tool') {
                // Return content instead of structuredContent
                return {
                    content: [{ type: 'text', text: 'This should be structured content' }]
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new LegacyTestClient(
            {
                name: 'test-client',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            },
                            tasks: {
                                get: true,
                                list: {},
                                result: true
                            }
                        }
                    }
                }
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should throw error
        await expect(client.callTool({ name: 'test-tool' })).rejects.toThrow(
            /Tool test-tool has an output schema but did not return structured content/
        );
    });

    /***
     * Test: Handle Tools Without outputSchema Normally
     */
    test('should handle tools without outputSchema normally', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler('initialize', async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler('tools/list', async () => ({
            tools: [
                {
                    name: 'test-tool',
                    description: 'A test tool',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    }
                    // No outputSchema
                }
            ]
        }));

        server.setRequestHandler('tools/call', async request => {
            if (request.params.name === 'test-tool') {
                // Return regular content
                return {
                    content: [{ type: 'text', text: 'Normal response' }]
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new LegacyTestClient(
            {
                name: 'test-client',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            },
                            tasks: {
                                get: true,
                                list: {},
                                result: true
                            }
                        }
                    }
                }
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should work normally without validation
        const result = await client.callTool({ name: 'test-tool' });
        expect(result.content).toEqual([{ type: 'text', text: 'Normal response' }]);
    });

    /***
     * Test: Handle Complex JSON Schema Validation
     */
    test('should handle complex JSON schema validation', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler('initialize', async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: {},
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler('tools/list', async () => ({
            tools: [
                {
                    name: 'complex-tool',
                    description: 'A tool with complex schema',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', minLength: 3 },
                            age: { type: 'integer', minimum: 0, maximum: 120 },
                            active: { type: 'boolean' },
                            tags: {
                                type: 'array',
                                items: { type: 'string' },
                                minItems: 1
                            },
                            metadata: {
                                type: 'object',
                                properties: {
                                    created: { type: 'string' }
                                },
                                required: ['created']
                            }
                        },
                        required: ['name', 'age', 'active', 'tags', 'metadata'],
                        additionalProperties: false
                    }
                }
            ]
        }));

        server.setRequestHandler('tools/call', async request => {
            if (request.params.name === 'complex-tool') {
                return {
                    structuredContent: {
                        name: 'John Doe',
                        age: 30,
                        active: true,
                        tags: ['user', 'admin'],
                        metadata: {
                            created: '2023-01-01T00:00:00Z'
                        }
                    }
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new LegacyTestClient(
            {
                name: 'test-client',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tasks: {
                        requests: {
                            tools: {
                                call: {}
                            },
                            tasks: {
                                get: true,
                                list: {},
                                result: true
                            }
                        }
                    }
                }
            }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should validate successfully
        const result = await client.callTool({ name: 'complex-tool' });
        expect(result.structuredContent).toBeDefined();
        const structuredContent = result.structuredContent as { name: string; age: number };
        expect(structuredContent.name).toBe('John Doe');
        expect(structuredContent.age).toBe(30);
    });

    /***
     * Test: Fail Validation with Additional Properties When Not Allowed
     */
    test('should fail validation with additional properties when not allowed', async () => {
        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0'
            },
            {
                capabilities: {
                    tools: {}
                }
            }
        );

        // Set up server handlers
        server.setRequestHandler('initialize', async request => ({
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: {
                name: 'test-server',
                version: '1.0.0'
            }
        }));

        server.setRequestHandler('tools/list', async () => ({
            tools: [
                {
                    name: 'strict-tool',
                    description: 'A tool with strict schema',
                    inputSchema: {
                        type: 'object',
                        properties: {}
                    },
                    outputSchema: {
                        type: 'object',
                        properties: {
                            name: { type: 'string' }
                        },
                        required: ['name'],
                        additionalProperties: false
                    }
                }
            ]
        }));

        server.setRequestHandler('tools/call', async request => {
            if (request.params.name === 'strict-tool') {
                // Return structured content with extra property
                return {
                    structuredContent: {
                        name: 'John',
                        extraField: 'not allowed'
                    }
                };
            }
            throw new Error('Unknown tool');
        });

        const client = new LegacyTestClient(
            {
                name: 'test-client',
                version: '1.0.0'
            },
            { capabilities: { tasks: { requests: { tools: { call: {} } } } } }
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // List tools to cache the schemas
        await client.listTools();

        // Call the tool - should throw validation error due to additional property
        await expect(client.callTool({ name: 'strict-tool' })).rejects.toThrow(
            /Structured content does not match the tool's output schema/
        );
    });
});

// The 2025-11 task suites that lived here are removed under SEP-2663:
//
// `Task-based execution` (Client calling server / Server calling client / Error scenarios):
//   Replacement coverage lands with the SEP-2663 tasks implementation; nothing in this
//   commit re-covers it. The server-to-client half (server polls client's tasks/*) is the
//   pattern SEP-2663 removes entirely; that direction becomes MRTR, not tasks.
//
// `should respect server task capabilities`:
//   Removed. Tasks is an extension under SEP-2663, not core protocol; there is no
//   client-side `assertCapabilityForMethod` case for `tasks/*`.
//
// `requestStream()` / `callToolStream()` (9 tests):
//   Removed. These tested incremental result streaming. SEP-2663's server-directed model
//   returns a CreateTaskResult pointer (not a stream). Use `callTool()` and inspect for
//   `{resultType: 'task'}`, then poll with `pollTask()`. The methods are removed.

describe('getSupportedElicitationModes', () => {
    test('should support nothing when capabilities are undefined', () => {
        const result = getSupportedElicitationModes(undefined);
        expect(result.supportsFormMode).toBe(false);
        expect(result.supportsUrlMode).toBe(false);
    });

    test('should default to form mode when capabilities are an empty object', () => {
        const result = getSupportedElicitationModes({});
        expect(result.supportsFormMode).toBe(true);
        expect(result.supportsUrlMode).toBe(false);
    });

    test('should support form mode when form is explicitly declared', () => {
        const result = getSupportedElicitationModes({ form: {} });
        expect(result.supportsFormMode).toBe(true);
        expect(result.supportsUrlMode).toBe(false);
    });

    test('should support url mode when url is explicitly declared', () => {
        const result = getSupportedElicitationModes({ url: {} });
        expect(result.supportsFormMode).toBe(false);
        expect(result.supportsUrlMode).toBe(true);
    });

    test('should support both modes when both are explicitly declared', () => {
        const result = getSupportedElicitationModes({ form: {}, url: {} });
        expect(result.supportsFormMode).toBe(true);
        expect(result.supportsUrlMode).toBe(true);
    });

    test('should support form mode when form declares applyDefaults', () => {
        const result = getSupportedElicitationModes({ form: { applyDefaults: true } });
        expect(result.supportsFormMode).toBe(true);
        expect(result.supportsUrlMode).toBe(false);
    });
});

describe('Client sampling validation with tools', () => {
    test('should validate array content with tool_use when request includes tools', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new LegacyTestClient({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        // Handler returns array content with tool_use - should validate with CreateMessageResultWithToolsSchema
        client.setRequestHandler('sampling/createMessage', async () => ({
            model: 'test-model',
            role: 'assistant',
            stopReason: 'toolUse',
            content: [{ type: 'tool_use', id: 'call_1', name: 'test_tool', input: { arg: 'value' } }]
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.legacy.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
            maxTokens: 100,
            tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
        });

        expect(result.stopReason).toBe('toolUse');
        expect(Array.isArray(result.content)).toBe(true);
        expect((result.content as Array<{ type: string }>)[0]!.type).toBe('tool_use');
    });

    test('should validate single content when request includes tools', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new LegacyTestClient({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        // Handler returns single content (text) - should still validate with CreateMessageResultWithToolsSchema
        client.setRequestHandler('sampling/createMessage', async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'No tool needed' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.legacy.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
            maxTokens: 100,
            tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }]
        });

        expect((result.content as { type: string }).type).toBe('text');
    });

    test('should validate single content when request has no tools', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new LegacyTestClient({ name: 'test client', version: '1.0' }, { capabilities: { sampling: {} } });

        // Handler returns single content - should validate with CreateMessageResultSchema
        client.setRequestHandler('sampling/createMessage', async () => ({
            model: 'test-model',
            role: 'assistant',
            content: { type: 'text', text: 'Response' }
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.legacy.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
            maxTokens: 100
        });

        expect((result.content as { type: string }).type).toBe('text');
    });

    test('should reject array content when request has no tools', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new LegacyTestClient({ name: 'test client', version: '1.0' }, { capabilities: { sampling: {} } });

        // Handler returns array content - should fail validation with CreateMessageResultSchema
        client.setRequestHandler('sampling/createMessage', async () => ({
            model: 'test-model',
            role: 'assistant',
            content: [{ type: 'text', text: 'Array response' }]
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        await expect(
            server.legacy.createMessage({
                messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
                maxTokens: 100
            })
        ).rejects.toThrow('Invalid sampling result');
    });

    test('should validate array content when request includes toolChoice', async () => {
        const server = new Server({ name: 'test server', version: '1.0' }, { capabilities: {} });

        const client = new LegacyTestClient({ name: 'test client', version: '1.0' }, { capabilities: { sampling: { tools: {} } } });

        // Handler returns array content with tool_use
        client.setRequestHandler('sampling/createMessage', async () => ({
            model: 'test-model',
            role: 'assistant',
            stopReason: 'toolUse',
            content: [{ type: 'tool_use', id: 'call_1', name: 'test_tool', input: {} }]
        }));

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await server.legacy.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: 'hello' } }],
            maxTokens: 100,
            tools: [{ name: 'test_tool', inputSchema: { type: 'object' } }],
            toolChoice: { mode: 'auto' }
        });

        expect(result.stopReason).toBe('toolUse');
        expect(Array.isArray(result.content)).toBe(true);
    });
});
