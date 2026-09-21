/**
 * Type-surface pin for the no-`argsSchema` prompt registration form.
 *
 * With no `argsSchema`, `createPromptHandler` invokes the callback as
 * `callback(ctx)` — the context is the ONLY argument (see `mcp.ts`,
 * the `else` branch of `createPromptHandler`). Both generic overloads
 * constrain `Args` to a schema type, so before the dedicated overload
 * existed the argument-less form resolved to the deprecated raw-shape
 * signature and typed `ctx` as the arguments record: reading
 * `ctx.mcpReq` was a type error even though it works at runtime.
 */
import type { ServerContext } from '@modelcontextprotocol/core-internal';
import { describe, expect, expectTypeOf, test } from 'vitest';

import { McpServer } from '../../src/server/mcp';

describe('registerPrompt without argsSchema', () => {
    test('types the callback parameter as the server context', () => {
        const server = new McpServer({ name: 'test server', version: '1.0' });

        server.registerPrompt('ctx-only', {}, async ctx => {
            expectTypeOf(ctx).toEqualTypeOf<ServerContext>();
            return { messages: [{ role: 'assistant' as const, content: { type: 'text' as const, text: String(ctx.mcpReq.id) } }] };
        });

        expect(server.server).toBeDefined();
    });

    test('still accepts a callback that ignores the context', () => {
        const server = new McpServer({ name: 'test server', version: '1.0' });

        server.registerPrompt('no-args', { description: 'takes nothing' }, async () => ({
            messages: [{ role: 'assistant' as const, content: { type: 'text' as const, text: 'ok' } }]
        }));

        expect(server.server).toBeDefined();
    });
});
