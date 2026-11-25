/**
 * The extension mechanism itself (SEP-3371 registration and middleware), as a
 * user sees it: what construction refuses, the order middleware runs in over
 * the wire, and an async `setup` failing `connect`.
 */

import type { ClientExtension } from '@modelcontextprotocol/client';
import { Client } from '@modelcontextprotocol/client';
import type { ServerExtension } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { wire } from '../helpers/index';
import { verifies } from '../helpers/verifies';
import type { TestArgs } from '../types';

const info = { name: 't', version: '0' };
const plain = (id: string): ServerExtension => ({ id, setup: () => {} });

verifies('extensions:registration:duplicate-id', async () => {
    expect(() => new McpServer(info, { extensions: [plain('com.example/a'), plain('com.example/a')] })).toThrow(
        'Extension "com.example/a" is listed more than once'
    );
    const twice: ClientExtension = { id: 'com.example/a', setup: () => {} };
    expect(() => new Client(info, { extensions: [twice, twice] })).toThrow('Extension "com.example/a" is listed more than once');
});

verifies('extensions:registration:require', async () => {
    const needsA: ServerExtension = { id: 'com.example/b', setup: ctx => ctx.require('com.example/a') };
    expect(() => new McpServer(info, { extensions: [needsA, plain('com.example/a')] })).not.toThrow();
    expect(() => new McpServer(info, { extensions: [needsA] })).toThrow('com.example/a');
});

verifies('extensions:registration:refused-method-names', async () => {
    const claims = (name: string): ServerExtension => ({
        id: 'com.example/claims',
        setup: ctx => ctx.setRequestHandler(name, { params: z.looseObject({}) }, () => ({}))
    });
    expect(() => new McpServer(info, { extensions: [claims('tools/list')] })).toThrow('it is a core method');
    expect(() => new McpServer(info, { extensions: [claims('notifications/cancelled')] })).toThrow('it is a core notification');

    const server = new McpServer(info);
    expect(() => server.server.use('subscriptions/listen', (req, ctx, next) => next(req, ctx))).toThrow(TypeError);
    expect(() => server.server.use('notifications/cancelled', (req, ctx, next) => next(req, ctx))).toThrow(TypeError);
    const client = new Client(info);
    expect(() => client.use('tools/call', (req, ctx, next) => next(req, ctx))).toThrow(TypeError);
});

verifies('extensions:middleware:order', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const order: string[] = [];
        const tier = (id: string): ServerExtension => ({
            id,
            setup: ctx =>
                ctx.use('tools/call', async (req, reqCtx, next) => {
                    order.push(id);
                    return next(req, reqCtx);
                })
        });
        const server = new McpServer(info, { extensions: [tier('com.example/first'), tier('com.example/second')] });
        server.server.use('tools/call', async (req, reqCtx, next) => {
            order.push('app');
            return next(req, reqCtx);
        });
        server.registerTool('order', {}, () => ({ content: [{ type: 'text', text: [...order, 'handler'].join(' > ') }] }));
        return server;
    };
    const client = new Client(info);
    await using _ = await wire(transport, makeServer, client);
    const result = await client.callTool({ name: 'order', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'com.example/first > com.example/second > app > handler' }]);
});

verifies('extensions:setup:async-failure-fails-connect', async ({ transport }: TestArgs) => {
    const failing: ClientExtension = {
        id: 'com.example/failing',
        async setup() {
            await Promise.resolve();
            throw new Error('setup failed');
        }
    };
    const client = new Client(info, { extensions: [failing] });
    await expect(wire(transport, () => new McpServer(info), client)).rejects.toThrow('setup failed');
});
