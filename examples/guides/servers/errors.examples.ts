/**
 * Companion example for `docs-v2/servers/errors.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: the harness below the
 * regions connects an in-memory client and produces the output the page quotes
 * verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/servers/errors.examples.ts        # from examples/
 *
 * @module
 */
/* eslint-disable no-console */
//#region registerTool_isError
import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const notes = new Map([['welcome', 'Read tools.md first.']]);

const server = new McpServer({ name: 'notes', version: '1.0.0' });

server.registerTool(
    'read-note',
    {
        description: 'Read a note by its id',
        inputSchema: z.object({ id: z.string() })
    },
    async ({ id }) => {
        const note = notes.get(id);
        if (!note) {
            return {
                content: [{ type: 'text', text: `No note with id "${id}". Known ids: ${[...notes.keys()].join(', ')}` }],
                isError: true
            };
        }
        return { content: [{ type: 'text', text: note }] };
    }
);
//#endregion registerTool_isError

//#region registerTool_throw
server.registerTool(
    'delete-note',
    {
        description: 'Delete a note by its id',
        inputSchema: z.object({ id: z.string() })
    },
    async ({ id }) => {
        if (!notes.delete(id)) {
            throw new Error(`Cannot delete "${id}": no such note`);
        }
        return { content: [{ type: 'text', text: `Deleted "${id}"` }] };
    }
);
//#endregion registerTool_throw

//#region registerResource_protocolError
server.registerResource(
    'note',
    new ResourceTemplate('note://{id}', { list: undefined }),
    { description: 'A note by its id' },
    async (uri, { id }) => {
        const noteId = String(id);
        if (!/^[a-z]+$/.test(noteId)) {
            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Note ids are lowercase letters, got "${noteId}"`);
        }
        const note = notes.get(noteId);
        if (!note) throw new ResourceNotFoundError(uri.href);
        return { contents: [{ uri: uri.href, text: note }] };
    }
);
//#endregion registerResource_protocolError

// ---------------------------------------------------------------------------
// Harness (not shown on the page). An in-memory client drives the calls whose
// output servers/errors.md quotes verbatim. Any MCP client behaves the same.
// Imported dynamically so the page's lead region stays self-contained.
// ---------------------------------------------------------------------------

const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');

const client = new Client({ name: 'errors-docs-harness', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

// "Return a tool error with isError" — the result the page quotes.
//#region callTool_isError
const missing = await client.callTool({ name: 'read-note', arguments: { id: 'drafts' } });
console.log(missing);
//#endregion callTool_isError

// "Let a thrown exception become a tool error" — the converted result the page quotes.
//#region callTool_throw
const thrown = await client.callTool({ name: 'delete-note', arguments: { id: 'drafts' } });
console.log(thrown);
//#endregion callTool_throw

// "Throw a protocol error" — the JSON-RPC error the page quotes.
//#region readResource_protocolError
try {
    await client.readResource({ uri: 'note://42' });
} catch (error) {
    const { code, message } = error as ProtocolError;
    console.log({ code, message });
}
//#endregion readResource_protocolError

// "Use the typed error subclasses" — the structured data the page quotes.
//#region readResource_notFound
try {
    await client.readResource({ uri: 'note://archived' });
} catch (error) {
    const { code, message, data } = error as ResourceNotFoundError;
    console.log({ code, message, data });
}
//#endregion readResource_notFound

// Proof for the page's claim that a thrown ProtocolError inside a TOOL handler
// is still converted to an `isError: true` result, never a JSON-RPC error.
// Throws (non-zero exit) if the claim is false.
server.registerTool('always-protocol-error', { description: 'Throws a ProtocolError' }, async () => {
    throw new ProtocolError(ProtocolErrorCode.InternalError, 'unreachable as a protocol error');
});
const converted = await client.callTool({ name: 'always-protocol-error', arguments: {} });
if (converted.isError !== true) {
    throw new Error(`errors.md claim failed: a ProtocolError thrown from a tool handler was not converted: ${JSON.stringify(converted)}`);
}

await client.close();
await server.close();
