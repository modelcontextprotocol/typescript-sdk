/**
 * Type-surface pins for the client's high-level methods.
 *
 * `callTool` returns plain `CallToolResult` on every protocol era — no task
 * union (a v2 client never sends a task-augmented call, so a task result is
 * unreachable from its API) and no wire-only members (`resultType` is
 * consumed at the protocol layer and never reaches consumers).
 */
import type { CallToolResult, EmptyResult, ListToolsResult, ReadResourceResult } from '@modelcontextprotocol/core-internal';
import { describe, expectTypeOf, test } from 'vitest';

import { Client } from '../../src/client/client.js';

type KnownKeyOf<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K] };

describe('client method return types', () => {
    test('callTool returns plain CallToolResult (no union, no wire-only members)', () => {
        type Return = Awaited<ReturnType<Client['callTool']>>;
        expectTypeOf<Return>().toEqualTypeOf<CallToolResult>();
        expectTypeOf<Extract<KnownKeyOf<Return>, 'resultType'>>().toEqualTypeOf<never>();
        expectTypeOf<Extract<KnownKeyOf<Return>, 'task'>>().toEqualTypeOf<never>();
    });

    test('the other request methods return the public result types', () => {
        expectTypeOf<Awaited<ReturnType<Client['ping']>>>().toEqualTypeOf<EmptyResult>();
        expectTypeOf<Awaited<ReturnType<Client['listTools']>>>().toEqualTypeOf<ListToolsResult>();
        expectTypeOf<Awaited<ReturnType<Client['readResource']>>>().toEqualTypeOf<ReadResourceResult>();
        expectTypeOf<Extract<KnownKeyOf<Awaited<ReturnType<Client['listTools']>>>, 'resultType'>>().toEqualTypeOf<never>();
    });
});
