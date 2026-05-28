/**
 * Self-contained test bodies for the logging surface.
 *
 * Each export is a {@link TestCase}: it builds its own server (via a factory),
 * builds its own client, wires them with {@link wire}, and asserts. There are
 * no shared fixture imports; helpers local to multiple bodies live at the top
 * of this file.
 *
 * Function names mirror the requirement id in camelCase; a `Raw` suffix marks
 * a low-level {@link Server} variant where the behavior under test differs by
 * tier.
 */

import { expect, vi } from 'vitest';
import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import { Server } from '../../../src/server/index.js';
import { McpServer } from '../../../src/server/mcp.js';
import {
    ErrorCode,
    isJSONRPCRequest,
    type LoggingLevel,
    LoggingLevelSchema,
    LoggingMessageNotificationSchema,
    McpError,
    RequestSchema
} from '../../../src/types.js';

import { tapWire, wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

const ALL_LEVELS: LoggingLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

/** Plain client with no extra capabilities declared. */
const newClient = () => new Client({ name: 'c', version: '0' });

/** McpServer factory that declares logging capability and can emit logs. */
function loggingServer(): McpServer {
    const s = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
    s.registerTool('ping', { inputSchema: z.object({}) }, () => ({ content: [{ type: 'text', text: 'pong' }] }));
    return s;
}

verifies('logging:capability:declared', async ({ transport }: TestArgs) => {
    const client = newClient();
    await using _ = await wire(transport, loggingServer, client);

    expect(client.getServerCapabilities()?.logging).toEqual({});
});

verifies('logging:message:fields', async ({ transport }: TestArgs) => {
    const logs: Array<{ level: LoggingLevel; logger?: string; data: unknown }> = [];

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        s.registerTool('emit-logs', { inputSchema: z.object({ withLogger: z.boolean().optional() }) }, async ({ withLogger }, extra) => {
            if (withLogger) {
                await extra.sendNotification({
                    method: 'notifications/message',
                    params: { level: 'info', logger: 'test-logger', data: 'with-logger' }
                });
            } else {
                await extra.sendNotification({
                    method: 'notifications/message',
                    params: { level: 'warning', data: 'without-logger' }
                });
            }
            for (const level of ALL_LEVELS) {
                await extra.sendNotification({
                    method: 'notifications/message',
                    params: { level, logger: 'sweep', data: `level-${level}` }
                });
            }
            return { content: [{ type: 'text', text: 'done' }] };
        });
        return s;
    };

    const client = newClient();
    client.setNotificationHandler(LoggingMessageNotificationSchema, n => {
        logs.push(n.params);
    });

    await using _ = await wire(transport, makeServer, client);

    await client.setLoggingLevel('debug');
    await client.callTool({ name: 'emit-logs', arguments: { withLogger: true } });
    await client.callTool({ name: 'emit-logs', arguments: { withLogger: false } });

    const sweep = ALL_LEVELS.map(level => ({ level, logger: 'sweep', data: `level-${level}` }));
    expect(logs).toEqual([
        { level: 'info', logger: 'test-logger', data: 'with-logger' },
        ...sweep,
        { level: 'warning', data: 'without-logger' },
        ...sweep
    ]);
    expect(logs[1 + ALL_LEVELS.length]).not.toHaveProperty('logger');
});

verifies('logging:message:all-levels', async ({ transport }: TestArgs) => {
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        server.registerTool('run-diagnostics', { inputSchema: z.object({}) }, async (_args, extra) => {
            for (const level of ALL_LEVELS) {
                await server.sendLoggingMessage({ level, logger: 'diagnostics', data: `a ${level} event` }, extra.sessionId);
            }
            return { content: [{ type: 'text', text: 'diagnostics complete' }] };
        });
        return server;
    };

    const received: Array<{ level: LoggingLevel; logger?: string; data: unknown }> = [];
    const client = newClient();
    client.setNotificationHandler(LoggingMessageNotificationSchema, n => {
        received.push(n.params);
    });

    await using _ = await wire(transport, makeServer, client);

    // No logging/setLevel is sent: with no threshold configured, every severity must be deliverable.
    const result = await client.callTool({ name: 'run-diagnostics', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: 'diagnostics complete' }]);

    await vi.waitFor(() => expect(received).toHaveLength(ALL_LEVELS.length));
    expect(received).toEqual(ALL_LEVELS.map(level => ({ level, logger: 'diagnostics', data: `a ${level} event` })));
});

verifies(['logging:message:filtered', 'logging:set-level'], async ({ transport }: TestArgs) => {
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        server.registerTool('emit-all', { inputSchema: z.object({}) }, async (_args, extra) => {
            for (const level of ALL_LEVELS) {
                await server.sendLoggingMessage({ level, data: level }, extra.sessionId);
            }
            return { content: [{ type: 'text', text: 'done' }] };
        });
        return server;
    };

    const client = newClient();
    await using _ = await wire(transport, makeServer, client);

    for (const threshold of ALL_LEVELS) {
        const thresholdRank = ALL_LEVELS.indexOf(threshold);
        const logs: LoggingLevel[] = [];
        client.setNotificationHandler(LoggingMessageNotificationSchema, n => {
            logs.push(n.params.level);
        });

        await client.setLoggingLevel(threshold);
        await client.callTool({ name: 'emit-all', arguments: {} });

        await vi.waitFor(() => expect(logs).toContain('emergency'));

        expect(logs).toEqual(ALL_LEVELS.slice(thresholdRank));
    }
});

verifies(
    'logging:set-level:invalid-level',
    async ({ transport }: TestArgs) => {
        const client = newClient();
        await using _ = await wire(transport, loggingServer, client);

        const tap = tapWire(client);

        // @ts-expect-error — sending an invalid enum value is the point of this test.
        await expect(client.setLoggingLevel('superduper')).rejects.toMatchObject({ code: ErrorCode.InvalidParams });
        expect(ErrorCode.InvalidParams).toBe(-32602);

        const sent = tap.sent.filter(m => isJSONRPCRequest(m) && m.method === 'logging/setLevel');
        expect(sent).toHaveLength(1);
        if (!isJSONRPCRequest(sent[0])) throw new Error('expected request');
        expect(sent[0].params).toEqual({ level: 'superduper' });
    },
    { title: 'mcpserver' }
);

verifies(
    'logging:set-level:invalid-level',
    async ({ transport }: TestArgs) => {
        // The user-shaped manual implementation of spec-correct invalid-level handling:
        // a handler registered with a loose params schema so the dispatch-time parse
        // succeeds, validating the level itself and throwing InvalidParams.
        const LooseSetLevelRequestSchema = RequestSchema.extend({
            method: z.literal('logging/setLevel'),
            params: z.object({ level: z.string() })
        });

        const applied: LoggingLevel[] = [];
        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { logging: {} } });
            s.setRequestHandler(LooseSetLevelRequestSchema, req => {
                const parsed = LoggingLevelSchema.safeParse(req.params.level);
                if (!parsed.success) {
                    throw new McpError(ErrorCode.InvalidParams, `Invalid logging level: ${req.params.level}`);
                }
                applied.push(parsed.data);
                return {};
            });
            return s;
        };

        const client = newClient();
        await using _ = await wire(transport, makeServer, client, { strictValidation: false });

        await client.setLoggingLevel('warning');
        expect(applied).toEqual(['warning']);

        // @ts-expect-error — sending an invalid enum value is the point of this test.
        await expect(client.setLoggingLevel('superduper')).rejects.toMatchObject({
            code: ErrorCode.InvalidParams,
            message: expect.stringContaining('superduper')
        });
        expect(applied).toEqual(['warning']);
    },
    { title: 'raw server' }
);

verifies('logging:out-of-band:basic', async ({ transport }: TestArgs) => {
    const received: Array<{ level: LoggingLevel; logger?: string; data: unknown }> = [];
    let server!: McpServer;
    const makeServer = () => {
        server = new McpServer({ name: 's', version: '0' }, { capabilities: { logging: {} } });
        return server;
    };

    const client = newClient();
    client.setNotificationHandler(LoggingMessageNotificationSchema, n => {
        received.push(n.params);
    });

    await using _ = await wire(transport, makeServer, client);

    // No request is in flight: this is a server-initiated, out-of-band notification.
    await server.sendLoggingMessage({ level: 'info', logger: 'job-runner', data: 'nightly index rebuild started' });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received).toEqual([{ level: 'info', logger: 'job-runner', data: 'nightly index rebuild started' }]);
});
