import { Readable, Writable } from 'node:stream';

import type { JSONRPCMessage } from '@modelcontextprotocol/core';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod/v4';

import { McpServer } from '../../src/server/mcp.js';
import { StdioServerTransport } from '../../src/server/modernStdio.js';

interface DiscoverResult {
    supportedVersions: string[];
    serverInfo: { name: string; version: string };
    capabilities: Record<string, unknown>;
}
interface JsonRpcOk<T> {
    jsonrpc: '2.0';
    id: number;
    result: T & { result_type?: string };
}
interface JsonRpcErr {
    jsonrpc: '2.0';
    id: number;
    error: { code: number; message: string };
}

function createMockStreams() {
    const input = new Readable({ read() {} });
    const messageResolvers: ((msg: JSONRPCMessage) => void)[] = [];
    const bufferedMessages: JSONRPCMessage[] = [];
    const outputBuffer = new ReadBuffer();

    const output = new Writable({
        write(chunk, _encoding, callback) {
            outputBuffer.append(chunk);
            while (true) {
                const msg = outputBuffer.readMessage();
                if (!msg) break;
                const resolver = messageResolvers.shift();
                if (resolver) {
                    resolver(msg);
                } else {
                    bufferedMessages.push(msg);
                }
            }
            callback();
        }
    });

    function nextMessage(): Promise<JSONRPCMessage> {
        const buffered = bufferedMessages.shift();
        if (buffered) return Promise.resolve(buffered);
        return new Promise(resolve => messageResolvers.push(resolve));
    }

    function sendToStdin(msg: JSONRPCMessage): void {
        input.push(serializeMessage(msg));
    }

    return { input, output, nextMessage, sendToStdin };
}

describe('StdioServerTransport (routing)', () => {
    let server: McpServer;
    let transport: StdioServerTransport;
    let nextMessage: () => Promise<JSONRPCMessage>;
    let sendToStdin: (msg: JSONRPCMessage) => void;

    beforeEach(async () => {
        server = new McpServer({ name: 'test-server', version: '1.0.0' });
        server.registerTool('greet', { description: 'Greet someone', inputSchema: { name: z.string() } }, async ({ name }) => ({
            content: [{ type: 'text', text: `Hello, ${name}!` }]
        }));

        const streams = createMockStreams();
        nextMessage = streams.nextMessage;
        sendToStdin = streams.sendToStdin;
        transport = new StdioServerTransport(streams.input, streams.output);
        await server.connect(transport);
    });

    describe('version detection', () => {
        it('detects modern from server/discover', async () => {
            sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: {
                    _meta: {
                        protocolVersion: '2026-06-30',
                        clientCapabilities: {},
                        clientInfo: { name: 'test-client', version: '1.0.0' }
                    }
                }
            });

            const response = (await nextMessage()) as unknown as JsonRpcOk<DiscoverResult>;
            expect(response.result.supportedVersions).toContain('2026-06-30');
            expect(response.result.serverInfo.name).toBe('test-server');
            expect(response.result.capabilities).toBeDefined();
        });

        it('detects modern from _meta.protocolVersion', async () => {
            sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: {
                    _meta: {
                        protocolVersion: '2026-06-30',
                        clientCapabilities: {},
                        clientInfo: { name: 'test-client', version: '1.0.0' }
                    }
                }
            });

            const response = (await nextMessage()) as JsonRpcOk<{ tools: unknown[]; result_type: string }>;
            expect(response.result.result_type).toBe('complete');
        });

        it('detects legacy from initialize', async () => {
            sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'legacy-client', version: '1.0.0' }
                }
            });

            const response = (await nextMessage()) as JsonRpcOk<{
                protocolVersion: string;
                capabilities: Record<string, unknown>;
                serverInfo: { name: string };
            }>;
            expect(response.result.protocolVersion).toBeDefined();
            expect(response.result.capabilities).toBeDefined();
            expect(response.result.serverInfo.name).toBe('test-server');
        });

        it('locks mode on first message', async () => {
            sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: {
                    _meta: {
                        protocolVersion: '2026-06-30',
                        clientCapabilities: {},
                        clientInfo: { name: 'test-client', version: '1.0.0' }
                    }
                }
            });

            await nextMessage();

            sendToStdin({
                jsonrpc: '2.0',
                id: 2,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'legacy-client', version: '1.0.0' }
                }
            });

            const response = (await nextMessage()) as JsonRpcErr;
            expect(response.error).toBeDefined();
        });
    });

    describe('modern path', () => {
        it('modern: tools/call', async () => {
            sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: {
                    _meta: {
                        protocolVersion: '2026-06-30',
                        clientCapabilities: {},
                        clientInfo: { name: 'test-client', version: '1.0.0' }
                    }
                }
            });

            await nextMessage();

            sendToStdin({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'World' },
                    _meta: {
                        protocolVersion: '2026-06-30',
                        clientCapabilities: {},
                        clientInfo: { name: 'test-client', version: '1.0.0' }
                    }
                }
            });

            const response = (await nextMessage()) as JsonRpcOk<{ content: { type: string; text: string }[]; result_type: string }>;
            expect(response.result.result_type).toBe('complete');
            expect(response.result.content).toMatchObject([{ type: 'text', text: 'Hello, World!' }]);
        });

        it('modern: tools/list', async () => {
            sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'server/discover',
                params: {
                    _meta: {
                        protocolVersion: '2026-06-30',
                        clientCapabilities: {},
                        clientInfo: { name: 'test-client', version: '1.0.0' }
                    }
                }
            });

            await nextMessage();

            sendToStdin({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/list',
                params: {
                    _meta: {
                        protocolVersion: '2026-06-30',
                        clientCapabilities: {},
                        clientInfo: { name: 'test-client', version: '1.0.0' }
                    }
                }
            });

            const response = (await nextMessage()) as JsonRpcOk<{ tools: { name: string }[]; result_type: string }>;
            expect(response.result.result_type).toBe('complete');
            expect(response.result.tools).toHaveLength(1);
            expect(response.result.tools).toMatchObject([{ name: 'greet' }]);
        });
    });

    describe('legacy path', () => {
        it('legacy: initialize + tools/call', async () => {
            sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'legacy-client', version: '1.0.0' }
                }
            });

            const initResponse = (await nextMessage()) as JsonRpcOk<{ protocolVersion: string }>;
            expect(initResponse.result.protocolVersion).toBeDefined();

            sendToStdin({
                jsonrpc: '2.0',
                method: 'notifications/initialized'
            });

            await new Promise(r => setTimeout(r, 10));

            sendToStdin({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'World' }
                }
            });

            const response = (await nextMessage()) as JsonRpcOk<{ content: { type: string; text: string }[] }>;
            expect(response.result.content).toMatchObject([{ type: 'text', text: 'Hello, World!' }]);
        });

        it('rapid messages during legacy init', async () => {
            sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'legacy-client', version: '1.0.0' }
                }
            });

            sendToStdin({
                jsonrpc: '2.0',
                method: 'notifications/initialized'
            });

            const initResponse = (await nextMessage()) as JsonRpcOk<{ protocolVersion: string }>;
            expect(initResponse.result.protocolVersion).toBeDefined();

            await new Promise(r => setTimeout(r, 10));

            sendToStdin({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'Rapid' }
                }
            });

            const response = (await nextMessage()) as JsonRpcOk<{ content: { type: string; text: string }[] }>;
            expect(response.result.content).toMatchObject([{ type: 'text', text: 'Hello, Rapid!' }]);
        });
    });

    describe('cross-path', () => {
        it('same tool returns identical content on both paths', async () => {
            const modernStreams = createMockStreams();
            const modernServer = new McpServer({ name: 'test-server', version: '1.0.0' });
            modernServer.registerTool('greet', { description: 'Greet someone', inputSchema: { name: z.string() } }, async ({ name }) => ({
                content: [{ type: 'text', text: `Hello, ${name}!` }]
            }));
            const modernTransport = new StdioServerTransport(modernStreams.input, modernStreams.output);
            await modernServer.connect(modernTransport);

            modernStreams.sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'Alice' },
                    _meta: {
                        protocolVersion: '2026-06-30',
                        clientCapabilities: {},
                        clientInfo: { name: 'test-client', version: '1.0.0' }
                    }
                }
            });

            const modernResponse = (await modernStreams.nextMessage()) as JsonRpcOk<{ content: { type: string; text: string }[] }>;

            const legacyStreams = createMockStreams();
            const legacyServer = new McpServer({ name: 'test-server', version: '1.0.0' });
            legacyServer.registerTool('greet', { description: 'Greet someone', inputSchema: { name: z.string() } }, async ({ name }) => ({
                content: [{ type: 'text', text: `Hello, ${name}!` }]
            }));
            const legacyTransport = new StdioServerTransport(legacyStreams.input, legacyStreams.output);
            await legacyServer.connect(legacyTransport);

            legacyStreams.sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'legacy-client', version: '1.0.0' }
                }
            });

            await legacyStreams.nextMessage();

            legacyStreams.sendToStdin({
                jsonrpc: '2.0',
                method: 'notifications/initialized'
            });

            await new Promise(r => setTimeout(r, 10));

            legacyStreams.sendToStdin({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                    name: 'greet',
                    arguments: { name: 'Alice' }
                }
            });

            const legacyResponse = (await legacyStreams.nextMessage()) as JsonRpcOk<{ content: { type: string; text: string }[] }>;

            expect(modernResponse.result.content).toEqual(legacyResponse.result.content);
            expect(modernResponse.result.content).toMatchObject([{ type: 'text', text: 'Hello, Alice!' }]);
        });

        it('handler registered after connect() is available on both paths', async () => {
            const modernStreams = createMockStreams();
            const sharedServer = new McpServer({ name: 'test-server', version: '1.0.0' });
            sharedServer.registerTool('seed', { description: 'Seed tool', inputSchema: z.object({}) }, async () => ({
                content: [{ type: 'text', text: 'seed' }]
            }));
            const modernTransport = new StdioServerTransport(modernStreams.input, modernStreams.output);
            await sharedServer.connect(modernTransport);

            vi.spyOn(sharedServer, 'sendToolListChanged').mockImplementation(() => {});
            sharedServer.registerTool(
                'late-tool',
                { description: 'Registered after connect', inputSchema: { x: z.number() } },
                async ({ x }) => ({
                    content: [{ type: 'text', text: `Result: ${x * 2}` }]
                })
            );

            modernStreams.sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'late-tool',
                    arguments: { x: 21 },
                    _meta: {
                        protocolVersion: '2026-06-30',
                        clientCapabilities: {},
                        clientInfo: { name: 'test-client', version: '1.0.0' }
                    }
                }
            });

            const modernResponse = (await modernStreams.nextMessage()) as JsonRpcOk<{ content: { type: string; text: string }[] }>;
            expect(modernResponse.result.content).toMatchObject([{ type: 'text', text: 'Result: 42' }]);

            const legacyStreams = createMockStreams();
            const legacyServer = new McpServer({ name: 'test-server', version: '1.0.0' });
            legacyServer.registerTool('seed', { description: 'Seed tool', inputSchema: z.object({}) }, async () => ({
                content: [{ type: 'text', text: 'seed' }]
            }));
            const legacyTransport = new StdioServerTransport(legacyStreams.input, legacyStreams.output);
            await legacyServer.connect(legacyTransport);

            vi.spyOn(legacyServer, 'sendToolListChanged').mockImplementation(() => {});
            legacyServer.registerTool(
                'late-tool',
                { description: 'Registered after connect', inputSchema: { x: z.number() } },
                async ({ x }) => ({
                    content: [{ type: 'text', text: `Result: ${x * 2}` }]
                })
            );

            legacyStreams.sendToStdin({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-11-25',
                    capabilities: {},
                    clientInfo: { name: 'legacy-client', version: '1.0.0' }
                }
            });

            await legacyStreams.nextMessage();

            legacyStreams.sendToStdin({
                jsonrpc: '2.0',
                method: 'notifications/initialized'
            });

            await new Promise(r => setTimeout(r, 10));

            legacyStreams.sendToStdin({
                jsonrpc: '2.0',
                id: 2,
                method: 'tools/call',
                params: {
                    name: 'late-tool',
                    arguments: { x: 21 }
                }
            });

            const legacyResponse = (await legacyStreams.nextMessage()) as JsonRpcOk<{ content: { type: string; text: string }[] }>;
            expect(legacyResponse.result.content).toMatchObject([{ type: 'text', text: 'Result: 42' }]);
        });
    });
});
