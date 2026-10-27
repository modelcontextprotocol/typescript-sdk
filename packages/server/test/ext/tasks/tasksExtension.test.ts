/**
 * `TasksExtension` binding and era rules: which principal a task is bound to,
 * and that the extension's methods and task handles are 2026-07-28 only.
 */
import { Client } from '@modelcontextprotocol/client';
import type { AuthInfo, JSONRPCRequest, MessageClassification } from '@modelcontextprotocol/core-internal';
import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    InMemoryTransport,
    PROTOCOL_VERSION_META_KEY,
    setNegotiatedProtocolVersion
} from '@modelcontextprotocol/core-internal';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { InMemoryTaskStore, TASKS_EXTENSION_ID, TasksExtension } from '../../../src/ext/tasks/index';
import { invoke } from '../../../src/server/invoke';
import { McpServer } from '../../../src/server/mcp';

const MODERN = '2026-07-28';
const CLASSIFICATION: MessageClassification = { era: 'modern', revision: MODERN };
const info = { name: 's', version: '1' };

const request = (method: string, params: Record<string, unknown>): JSONRPCRequest => ({
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
        ...params,
        _meta: {
            [PROTOCOL_VERSION_META_KEY]: MODERN,
            [CLIENT_INFO_META_KEY]: { name: 'c', version: '1' },
            [CLIENT_CAPABILITIES_META_KEY]: { extensions: { [TASKS_EXTENSION_ID]: {} } }
        }
    }
});

const auth = (clientId: string, sub?: string): AuthInfo => ({
    token: 't',
    clientId,
    scopes: [],
    ...(sub !== undefined && { extra: { sub } })
});

function serve(tasks: TasksExtension) {
    const mcp = new McpServer(info, { extensions: [tasks] });
    mcp.registerTool('job', { inputSchema: z.object({}) }, async (_args, ctx) => tasks.create(ctx));
    return mcp;
}

async function call(tasks: TasksExtension, method: string, params: Record<string, unknown>, authInfo?: AuthInfo) {
    const mcp = serve(tasks);
    setNegotiatedProtocolVersion(mcp.server, MODERN);
    const response = await invoke(mcp.server, request(method, params), {
        classification: CLASSIFICATION,
        ...(authInfo !== undefined && { authInfo })
    });
    return (await response.json()) as { result?: Record<string, unknown>; error?: { code: number } };
}

describe('TasksExtension principal', () => {
    let store: InMemoryTaskStore;
    afterEach(() => store.close());

    it('binds a task to the client id and token subject by default, so users of one client stay apart', async () => {
        store = new InMemoryTaskStore();
        const tasks = new TasksExtension(store);
        const created = await call(tasks, 'tools/call', { name: 'job', arguments: {} }, auth('shared-app', 'alice'));
        const taskId = created.result?.['taskId'] as string;
        expect((await call(tasks, 'tasks/get', { taskId }, auth('shared-app', 'alice'))).result).toMatchObject({ taskId });
        expect((await call(tasks, 'tasks/get', { taskId }, auth('shared-app', 'bob'))).error).toMatchObject({ code: -32_602 });
        expect((await call(tasks, 'tasks/get', { taskId }, auth('other-app', 'alice'))).error).toMatchObject({ code: -32_602 });
    });

    it('uses the principal option when given', async () => {
        store = new InMemoryTaskStore();
        const tasks = new TasksExtension(store, { principal: ctx => ctx.http?.authInfo?.extra?.['tenant'] as string | undefined });
        const tenant = (name: string): AuthInfo => ({ token: 't', clientId: 'app', scopes: [], extra: { tenant: name } });
        const created = await call(tasks, 'tools/call', { name: 'job', arguments: {} }, tenant('acme'));
        const taskId = created.result?.['taskId'] as string;
        expect((await call(tasks, 'tasks/get', { taskId }, tenant('acme'))).result).toMatchObject({ taskId });
        expect((await call(tasks, 'tasks/get', { taskId }, tenant('globex'))).error).toMatchObject({ code: -32_602 });
    });
});

describe('TasksExtension on 2025-11-25', () => {
    it('answers the tasks methods with -32601 and refuses task handles with -32021', async () => {
        const store = new InMemoryTaskStore();
        const mcp = serve(new TasksExtension(store));
        const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
        await mcp.connect(serverTx);
        const client = new Client({ name: 'c', version: '1' }, { capabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } });
        await client.connect(clientTx);

        await expect(client.request({ method: 'tasks/get', params: { taskId: 'x' } }, z.looseObject({}))).rejects.toMatchObject({
            code: -32_601
        });
        await expect(
            client.request({ method: 'tasks/update', params: { taskId: 'x', inputResponses: {} } }, z.looseObject({}))
        ).rejects.toMatchObject({
            code: -32_601
        });
        await expect(client.callTool({ name: 'job', arguments: {} })).rejects.toMatchObject({ code: -32_021 });

        await client.close();
        store.close();
    });
});
