/**
 * Form-mode elicitation: a tool that collects structured user input via
 * `ctx.mcpReq.elicitInput({ mode: 'form', ... })`. The client validates the
 * form against `requestedSchema` and answers `accept`/`decline`/`cancel`.
 * One binary, either transport.
 */
import { McpServer } from '@modelcontextprotocol/server';

import { runServerFromArgs } from '../harness.js';

function buildServer(): McpServer {
    const server = new McpServer({ name: 'elicitation-form-example', version: '1.0.0' });

    server.registerTool('register_user', { description: 'Register a new user account by collecting their information' }, async ctx => {
        const result = await ctx.mcpReq.elicitInput({
            mode: 'form',
            message: 'Please provide your registration information:',
            requestedSchema: {
                type: 'object',
                properties: {
                    username: { type: 'string', title: 'Username', minLength: 3, maxLength: 20 },
                    email: { type: 'string', title: 'Email', format: 'email' },
                    newsletter: { type: 'boolean', title: 'Subscribe to newsletter?', default: false }
                },
                required: ['username', 'email']
            }
        });
        if (result.action !== 'accept' || !result.content) {
            return { content: [{ type: 'text', text: `registration ${result.action}` }] };
        }
        const { username, email, newsletter } = result.content as { username: string; email: string; newsletter?: boolean };
        return {
            content: [{ type: 'text', text: `registered ${username} <${email}> (newsletter: ${newsletter ? 'yes' : 'no'})` }]
        };
    });

    return server;
}

runServerFromArgs(buildServer);
