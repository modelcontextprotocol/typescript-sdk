import { randomUUID } from 'node:crypto';

import type { JSONRPCMessage, MessageExtraInfo } from '@modelcontextprotocol/core-internal';

import { McpServer } from '../../src/server/mcp';
import type { EventId, EventStore, StreamId } from '../../src/server/streamableHttp';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

/**
 * Gate-closure tests for the two protocol-version checks that guard
 * resumability behavior (priming events and `closeSSEStream` callbacks).
 *
 * The protocol version in an `initialize` request body is NOT validated
 * against `supportedProtocolVersions` (unlike the `MCP-Protocol-Version`
 * header), so these gates must be bounded: only versions the transport
 * instance actually supports may enable the resumability behavior introduced
 * with protocol version 2025-11-25. An unknown future version string must
 * behave like a client that does not support it.
 */

function initializeRequest(protocolVersion: string): Request {
    const body = {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
            clientInfo: { name: 'test-client', version: '1.0' },
            protocolVersion,
            capabilities: {}
        },
        id: 'init-1'
    } as JSONRPCMessage;

    return new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream'
        },
        body: JSON.stringify(body)
    });
}

async function readFirstSSEChunk(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    const { value } = await reader!.read();
    return new TextDecoder().decode(value);
}

/**
 * A priming event is an SSE event with an event ID and empty data,
 * e.g. `id: <eventId>\ndata: \n\n`.
 */
function isPrimingEvent(sseChunk: string): boolean {
    const lines = sseChunk.split('\n');
    const dataLine = lines.find(line => line.startsWith('data:'));
    return lines.some(line => line.startsWith('id:')) && dataLine !== undefined && dataLine.slice(5).trim() === '';
}

describe('WebStandardStreamableHTTPServerTransport - future-version gate closure', () => {
    let transport: WebStandardStreamableHTTPServerTransport;
    let mcpServer: McpServer;
    let storedEvents: Map<EventId, { streamId: StreamId; message: JSONRPCMessage }>;
    let capturedExtras: Array<MessageExtraInfo | undefined>;

    beforeEach(async () => {
        storedEvents = new Map();
        capturedExtras = [];

        const eventStore: EventStore = {
            async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
                const eventId = `${streamId}_${storedEvents.size}`;
                storedEvents.set(eventId, { streamId, message });
                return eventId;
            },
            async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
                return storedEvents.get(eventId)?.streamId;
            },
            async replayEventsAfter(): Promise<StreamId> {
                throw new Error('not used in these tests');
            }
        };

        mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });
        transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            eventStore
        });
        await mcpServer.connect(transport);

        // Capture the per-message extras (closeSSEStream availability) while
        // preserving normal server dispatch.
        const serverOnMessage = transport.onmessage;
        transport.onmessage = (message, extra) => {
            capturedExtras.push(extra);
            serverOnMessage?.(message, extra);
        };
    });

    afterEach(async () => {
        await transport.close();
    });

    function expectPrimingEventStored(expected: boolean): void {
        // The priming event is stored as an empty message; real messages always
        // have at least a `jsonrpc` member.
        const primingStored = [...storedEvents.values()].some(event => Object.keys(event.message).length === 0);
        expect(primingStored).toBe(expected);
    }

    describe('unknown future protocol versions in the initialize body', () => {
        // Far-future sentinels, deliberately not the next planned revision
        // (2026-07-28): these cases must stay "unknown" when real future
        // versions gain support, rather than silently inverting.
        it.each(['2099-01-01', '2099-12-31'])('does not send a priming event for protocol version %s', async futureVersion => {
            const response = await transport.handleRequest(initializeRequest(futureVersion));
            expect(response.status).toBe(200);

            const firstChunk = await readFirstSSEChunk(response);
            // The first SSE event must be the initialize response, not a priming event.
            expect(isPrimingEvent(firstChunk)).toBe(false);
            expect(firstChunk).toContain('"result"');

            expectPrimingEventStored(false);
        });

        it.each(['2099-01-01', '2099-12-31'])('does not provide closeSSEStream callbacks for protocol version %s', async futureVersion => {
            const response = await transport.handleRequest(initializeRequest(futureVersion));
            expect(response.status).toBe(200);

            expect(capturedExtras).toHaveLength(1);
            expect(capturedExtras[0]?.closeSSEStream).toBeUndefined();
            expect(capturedExtras[0]?.closeStandaloneSSEStream).toBeUndefined();
        });
    });

    describe('existing protocol versions keep their behavior', () => {
        // Only 2025-11-25 (the version that introduced the empty-SSE-data fix)
        // takes the resumability paths - exactly as before the gates were bounded.
        const expectations: Array<[string, boolean]> = [
            ['2024-10-07', false],
            ['2024-11-05', false],
            ['2025-03-26', false],
            ['2025-06-18', false],
            ['2025-11-25', true]
        ];

        it.each(expectations)('priming event for protocol version %s: %s', async (version, expectPriming) => {
            const response = await transport.handleRequest(initializeRequest(version));
            expect(response.status).toBe(200);

            const firstChunk = await readFirstSSEChunk(response);
            expect(isPrimingEvent(firstChunk)).toBe(expectPriming);

            expectPrimingEventStored(expectPriming);
        });

        it.each(expectations)('closeSSEStream callbacks for protocol version %s: %s', async (version, expectAvailable) => {
            const response = await transport.handleRequest(initializeRequest(version));
            expect(response.status).toBe(200);

            expect(capturedExtras).toHaveLength(1);
            expect(capturedExtras[0]?.closeSSEStream !== undefined).toBe(expectAvailable);
            expect(capturedExtras[0]?.closeStandaloneSSEStream !== undefined).toBe(expectAvailable);
        });
    });
});
