/**
 * Compile-time type checks for McpServer registration methods.
 *
 * These verify that generic type parameters resolve correctly for the
 * no-argsSchema and with-argsSchema overloads of registerPrompt.
 */
import type { GetPromptResult, ServerContext } from '@modelcontextprotocol/core';
import { describe, it } from 'vitest';
import * as z from 'zod/v4';

import { McpServer } from '../../src/server/mcp.js';

/* eslint-disable @typescript-eslint/no-unused-vars */

declare const server: McpServer;
declare const result: GetPromptResult;

// Without argsSchema, the callback must accept (ctx) only.
// Before the fix, Args had no default and could not be undefined, so the
// PromptCallback conditional never resolved to the no-args branch.
function registerPrompt_noArgs() {
    server.registerPrompt('no-args', {}, (ctx: ServerContext) => result);

    // @ts-expect-error -- callback cannot take an args parameter when argsSchema is omitted
    server.registerPrompt('no-args', {}, (args: { code: string }, ctx: ServerContext) => result);
}

// With argsSchema, the callback must accept (args, ctx).
function registerPrompt_withArgs() {
    server.registerPrompt(
        'with-args',
        { argsSchema: z.object({ code: z.string() }) },
        (args: { code: string }, ctx: ServerContext) => result
    );
}

describe('registerPrompt types', () => {
    it('compiles', () => {
        // The functions above are compile-time type assertions; this suite
        // exists so vitest detects the file as containing tests.
    });
});
