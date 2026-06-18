/**
 * "Real app" capstone — a small stateful sticky-notes board that ties
 * together tools that mutate state, a resource per piece of state, listChanged
 * on add/remove, and a server→client elicitation guarding a destructive action.
 *
 * The board is process-local (one map per server process). Over stdio one
 * `McpServer` instance is pinned for the connection lifetime, so the tools
 * register/unregister note resources at runtime; over the per-request HTTP
 * path the factory registers a resource per live note on every request.
 *
 * Tools:
 *   - `add_note(text)` — store a note, register `note:///{id}`, returns
 *     `{id, uri}`.
 *   - `remove_note(id)` — delete one note + unregister its resource.
 *   - `remove_all()` — delete every note, but FIRST blocks on a form-mode
 *     elicitation; declining/cancelling/unchecked all leave the board.
 *
 * One binary, either transport.
 */
import type { RegisteredResource } from '@modelcontextprotocol/server';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { runServerFromArgs } from '../harness.js';

const notes = new Map<string, string>();
let nextId = 1;
const uriFor = (id: string) => `note:///${id}`;

function buildServer(): McpServer {
    const server = new McpServer({ name: 'stickynotes-example', version: '1.0.0' }, { capabilities: { resources: { listChanged: true } } });
    // Registrations on THIS instance (so the stdio leg can unregister at runtime).
    const registered = new Map<string, RegisteredResource>();
    const registerNote = (id: string, text: string) => {
        const r = server.registerResource(
            `note-${id}`,
            uriFor(id),
            { mimeType: 'text/plain', description: `Sticky note #${id}` },
            async uri => ({
                contents: [{ uri: uri.href, mimeType: 'text/plain', text: notes.get(id) ?? text }]
            })
        );
        registered.set(id, r);
    };
    // Register a resource per live note (per-request HTTP path picks up the
    // current board on every factory call; stdio re-uses one instance).
    for (const [id, text] of notes) registerNote(id, text);

    server.registerTool(
        'add_note',
        {
            description: 'Add a sticky note; registers a note:///{id} resource for it.',
            inputSchema: z.object({ text: z.string() }),
            outputSchema: z.object({ id: z.string(), uri: z.string() })
        },
        async ({ text }) => {
            const id = String(nextId++);
            notes.set(id, text);
            registerNote(id, text);
            const structuredContent = { id, uri: uriFor(id) };
            return { content: [{ type: 'text', text: `added note #${id}` }], structuredContent };
        }
    );

    server.registerTool(
        'remove_note',
        {
            description: 'Remove one sticky note by id and unregister its resource.',
            inputSchema: z.object({ id: z.string() }),
            outputSchema: z.object({ removed: z.boolean(), id: z.string() })
        },
        async ({ id }) => {
            const removed = notes.delete(id);
            if (removed) registered.get(id)?.remove();
            return { content: [{ type: 'text', text: removed ? `removed #${id}` : 'not found' }], structuredContent: { removed, id } };
        }
    );

    server.registerTool(
        'remove_all',
        {
            description: 'Remove ALL sticky notes after confirming via a server→client elicitation.',
            outputSchema: z.object({ status: z.string(), removed: z.number() })
        },
        async ctx => {
            if (notes.size === 0) {
                return { content: [{ type: 'text', text: 'nothing to clear' }], structuredContent: { status: 'empty', removed: 0 } };
            }
            const count = notes.size;
            const result = await ctx.mcpReq.elicitInput({
                mode: 'form',
                message: `Remove all ${count} sticky note(s)? This cannot be undone.`,
                requestedSchema: {
                    type: 'object',
                    properties: { confirm: { type: 'boolean', title: 'Yes, permanently delete every sticky note' } },
                    required: ['confirm']
                }
            });
            if (result.action === 'cancel') {
                return { content: [{ type: 'text', text: 'cancelled' }], structuredContent: { status: 'cancelled', removed: 0 } };
            }
            if (result.action !== 'accept' || !(result.content as { confirm?: boolean } | undefined)?.confirm) {
                return { content: [{ type: 'text', text: 'declined' }], structuredContent: { status: 'declined', removed: 0 } };
            }
            for (const id of notes.keys()) registered.get(id)?.remove();
            notes.clear();
            return { content: [{ type: 'text', text: `cleared ${count}` }], structuredContent: { status: 'cleared', removed: count } };
        }
    );

    return server;
}

// runServerFromArgs is the example harness's transport selector (default stdio, --http for HTTP). In your own server you'd call serveStdio(buildServer) or createMcpHandler(buildServer) directly.
runServerFromArgs(buildServer);
