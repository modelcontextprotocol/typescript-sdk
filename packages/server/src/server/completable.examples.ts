/**
 * Type-checked examples for `completable.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import * as z from 'zod/v4';

import { completable } from './completable.js';
import { McpServer } from './mcp.js';

/**
 * Example: Using completable() in a prompt registration.
 */
function completable_basicUsage() {
    const server = new McpServer({ name: 'my-server', version: '1.0.0' });

    //#region completable_basicUsage
    server.registerPrompt(
        'review-code',
        {
            title: 'Code Review',
            argsSchema: z.object({
                language: completable(z.string().describe('Programming language'), value =>
                    ['typescript', 'javascript', 'python', 'rust', 'go'].filter(lang => lang.startsWith(value))
                )
            })
        },
        ({ language }) => ({
            messages: [
                {
                    role: 'user' as const,
                    content: {
                        type: 'text' as const,
                        text: `Review this ${language} code.`
                    }
                }
            ]
        })
    );
    //#endregion completable_basicUsage
    return server;
}
