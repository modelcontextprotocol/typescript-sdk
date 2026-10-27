import { AsyncLocalStorage } from 'node:async_hooks';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';

import type { OperationOutcome, ProtocolInstrumentation } from '@modelcontextprotocol/client';
import { Client, InMemoryTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { listenOnRandomPort } from '@modelcontextprotocol/test-helpers';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

interface Observed {
    side: string;
    direction: 'send' | 'receive';
    method: string;
    params?: Readonly<Record<string, unknown>>;
    meta?: Readonly<Record<string, unknown>>;
    protocolVersion?: string;
    httpRequest?: Request;
    /** The scope active where the operation started. */
    parent?: string;
    outcomes: OperationOutcome[];
}

/** A minimal tracer: every operation gets an id, propagated through `traceparent` and made active with `AsyncLocalStorage`. */
function tracer(side: string, als: AsyncLocalStorage<string>, observed: Observed[]): ProtocolInstrumentation {
    let next = 0;
    return {
        send(operation) {
            const id = `${side}:${next++}`;
            const entry: Observed = {
                side,
                direction: 'send',
                method: operation.method,
                params: operation.params,
                parent: als.getStore(),
                outcomes: []
            };
            observed.push(entry);
            operation.carrier.traceparent = id;
            return { run: fn => als.run(id, fn), end: outcome => entry.outcomes.push(outcome) };
        },
        receive(operation) {
            const id = `${side}:${next++}`;
            const entry: Observed = {
                side,
                direction: 'receive',
                method: operation.method,
                params: operation.params,
                meta: operation.meta,
                protocolVersion: operation.protocolVersion,
                httpRequest: operation.httpRequest,
                parent: operation.meta?.traceparent as string | undefined,
                outcomes: []
            };
            observed.push(entry);
            return { run: fn => als.run(id, fn), end: outcome => entry.outcomes.push(outcome) };
        }
    };
}

describe('instrumentation on Client and McpServer', () => {
    const cleanups: Array<() => Promise<void> | void> = [];
    afterEach(async () => {
        while (cleanups.length > 0) await cleanups.pop()!();
    });

    it('follows a tool call from the client into the tool and back out through a nested elicitation', async () => {
        const als = new AsyncLocalStorage<string>();
        const observed: Observed[] = [];
        const server = new McpServer({ name: 'traced', version: '1.0.0' }, { instrumentation: tracer('server', als, observed) });
        let activeInTool: string | undefined;
        server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, async ({ name }, ctx) => {
            activeInTool = als.getStore();
            const answer = await ctx.mcpReq.elicitInput({
                mode: 'form',
                message: 'Greeting?',
                requestedSchema: { type: 'object', properties: { word: { type: 'string' } } }
            });
            return { content: [{ type: 'text', text: `${answer.content?.word} ${name}` }] };
        });
        const client = new Client(
            { name: 'traced-client', version: '1.0.0' },
            { capabilities: { elicitation: {} }, instrumentation: tracer('client', als, observed) }
        );
        let activeInElicitation: string | undefined;
        client.setRequestHandler('elicitation/create', () => {
            activeInElicitation = als.getStore();
            return { action: 'accept', content: { word: 'hello' } };
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
        cleanups.push(() => client.close());

        const result = await als.run('agent', () => client.callTool({ name: 'greet', arguments: { name: 'Ada' } }));
        expect(result.content).toEqual([{ type: 'text', text: 'hello Ada' }]);

        const clientCall = observed.find(o => o.side === 'client' && o.direction === 'send' && o.method === 'tools/call')!;
        expect(clientCall).toMatchObject({ parent: 'agent', params: { name: 'greet', arguments: { name: 'Ada' } } });
        expect(clientCall.outcomes).toEqual([{ type: 'result', result: { content: [{ type: 'text', text: 'hello Ada' }] } }]);

        const serverCall = observed.find(o => o.side === 'server' && o.direction === 'receive' && o.method === 'tools/call')!;
        const clientCallId = serverCall.parent!;
        expect(clientCallId).toMatch(/^client:/);
        expect(serverCall.outcomes).toHaveLength(1);

        const serverElicit = observed.find(o => o.side === 'server' && o.direction === 'send' && o.method === 'elicitation/create')!;
        expect(serverElicit.parent).toBe(activeInTool);
        const clientElicit = observed.find(o => o.side === 'client' && o.direction === 'receive' && o.method === 'elicitation/create')!;
        expect(clientElicit.parent).toMatch(/^server:/);
        expect(activeInElicitation).toMatch(/^client:/);
        expect(clientElicit.outcomes).toEqual([{ type: 'result', result: { action: 'accept', content: { word: 'hello' } } }]);
    });

    it('observes each request served by createMcpHandler with one shared instrumentation', async () => {
        const als = new AsyncLocalStorage<string>();
        const observed: Observed[] = [];
        const instrumentation = tracer('server', als, observed);
        const handler = createMcpHandler(() => {
            const server = new McpServer({ name: 'traced-http', version: '1.0.0' }, { instrumentation });
            server.registerTool('greet', { inputSchema: z.object({ name: z.string() }) }, ({ name }) => ({
                content: [{ type: 'text', text: `hello ${name}` }]
            }));
            return server;
        });
        const httpServer: HttpServer = createServer(toNodeHandler(handler));
        const baseUrl = await listenOnRandomPort(httpServer);
        cleanups.push(async () => {
            await handler.close();
            httpServer.close();
        });
        const client = new Client(
            { name: 'traced-client', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto' }, instrumentation: tracer('client', als, observed) }
        );
        await client.connect(new StreamableHTTPClientTransport(baseUrl));
        cleanups.push(() => client.close());

        await client.callTool({ name: 'greet', arguments: { name: 'Ada' } });

        const serverCall = observed.find(o => o.side === 'server' && o.direction === 'receive' && o.method === 'tools/call')!;
        expect(serverCall.protocolVersion).toBe('2026-07-28');
        expect(serverCall.httpRequest).toBeInstanceOf(Request);
        expect(serverCall.parent).toMatch(/^client:/);
        expect(serverCall.outcomes).toMatchObject([{ type: 'result' }]);
    });
});
