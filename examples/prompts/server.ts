/**
 * Prompts primitive + completion.
 *
 * Register prompts with `McpServer.registerPrompt`; wrap an arg schema with
 * `completable(...)` so the client's `complete()` call returns suggestions.
 * One binary, either transport.
 */
import { completable, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

const LANGUAGES = ['python', 'typescript', 'rust', 'go'];

function buildServer(): McpServer {
    const server = new McpServer({ name: 'prompts-example', version: '1.0.0' });

    server.registerPrompt(
        'review-code',
        {
            title: 'Code review',
            description: 'Review code for quality and idioms',
            argsSchema: z.object({
                language: completable(z.string().describe('Programming language'), value => LANGUAGES.filter(l => l.startsWith(value))),
                code: z.string().describe('The code to review')
            })
        },
        async ({ language, code }) => ({
            messages: [
                {
                    role: 'user',
                    content: { type: 'text', text: `Review this ${language} code for quality and idioms:\n\n${code}` }
                }
            ]
        })
    );

    return server;
}

runServerFromArgs(buildServer);
