---
shape: how-to
---
# Errors

A **tool error** is a successful JSON-RPC result with `isError: true` that the model reads and recovers from. A **protocol error** is a JSON-RPC error response the model never sees.

## Return a tool error with `isError`

Return `isError: true` from a tool handler to report a failure the model should see.

```ts source="../../examples/guides/servers/errors.examples.ts#registerTool_isError"
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
```

Every call on this page comes from an in-memory `Client` connected to the server above — [Test a server](../testing.md) shows that wiring. Call `read-note` with an id that does not exist.

```ts source="../../examples/guides/servers/errors.examples.ts#callTool_isError"
const missing = await client.callTool({ name: 'read-note', arguments: { id: 'drafts' } });
console.log(missing);
```

The `tools/call` response is an ordinary result:

```
{
  content: [
    {
      type: 'text',
      text: 'No note with id "drafts". Known ids: welcome'
    }
  ],
  isError: true
}
```

The model reads the message, sees `welcome` in it, and retries with an id that exists. Put the recovery hint in `text` — it is the only thing the model has to work with.

## Let a thrown exception become a tool error

Throw instead: the SDK catches anything a tool handler throws and converts it to the same `isError: true` shape.

```ts source="../../examples/guides/servers/errors.examples.ts#registerTool_throw"
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
```

Call `delete-note` with the same missing id.

```ts source="../../examples/guides/servers/errors.examples.ts#callTool_throw"
const thrown = await client.callTool({ name: 'delete-note', arguments: { id: 'drafts' } });
console.log(thrown);
```

The exception's `message` becomes the result's `content` text:

```
{
  content: [ { type: 'text', text: 'Cannot delete "drafts": no such note' } ],
  isError: true
}
```

A throw and an explicit `isError: true` produce the same shape; returning explicitly gives you control over `content`. The SDK skips `outputSchema` validation on any `isError` result.

## Throw a protocol error

Resource, prompt, and completion callbacks have no `isError` channel. Throw `ProtocolError(code, message, data?)` when the request itself is wrong.

```ts source="../../examples/guides/servers/errors.examples.ts#registerResource_protocolError"
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
```

::: info Coming from v1?
`ProtocolError` and `ProtocolErrorCode` replace v1's `McpError` and `ErrorCode` — run the codemod, then see the [upgrade guide](../migration/upgrade-to-v2.md).
:::

Read the resource with an id the callback rejects.

```ts source="../../examples/guides/servers/errors.examples.ts#readResource_protocolError"
try {
    await client.readResource({ uri: 'note://42' });
} catch (error) {
    const { code, message } = error as ProtocolError;
    console.log({ code, message });
}
```

`readResource` rejects with a `ProtocolError` carrying the wire fields:

```
{ code: -32602, message: 'Note ids are lowercase letters, got "42"' }
```

On the wire this is a JSON-RPC error response — `{ code, message, data? }` instead of a `result` — and the host's MCP client handles it; the model never sees it. A non-`ProtocolError` exception thrown from one of these callbacks surfaces as `-32603` Internal Error with the exception's message.

## Choose between tool error and protocol error

Pick by audience. The model drives `tools/call`, so a failure it can recover from — a missing record, a bad argument, a transient upstream fault — belongs in `isError: true` with a message that names the fix. The host application drives `resources/read`, `prompts/get`, and `completion/complete`, so failures there are protocol errors addressed to the caller's code.

The handler decides which channel exists:

- A tool handler produces only tool errors. The SDK converts every exception it throws — including a thrown `ProtocolError` — into an `isError: true` result. `UrlElicitationRequiredError` is the one exception; it propagates as a JSON-RPC error so the host can open the URL — see [Elicitation](./elicitation.md).
- A resource, prompt, or completion callback produces only protocol errors. Throw a `ProtocolError`.

## Use the typed error subclasses

Each subclass picks the right `ProtocolErrorCode` and packs structured `data` for you. `ResourceNotFoundError` takes the missing URI — the read callback above already throws it for a well-formed id with no note.

```ts source="../../examples/guides/servers/errors.examples.ts#readResource_notFound"
try {
    await client.readResource({ uri: 'note://archived' });
} catch (error) {
    const { code, message, data } = error as ResourceNotFoundError;
    console.log({ code, message, data });
}
```

The error carries the requested URI in `data` and the code the spec mandates for a `resources/read` miss:

```
{
  code: -32602,
  message: 'Resource not found: note://archived',
  data: { uri: 'note://archived' }
}
```

Three more subclasses cover the other structured protocol errors:

- `UrlElicitationRequiredError(elicitations)` — `-32042`; the only error a tool handler can propagate. See [Elicitation](./elicitation.md).
- `UnsupportedProtocolVersionError({ supported, requested })` — `-32022`; `data.supported` lets the peer pick a version and retry.
- `MissingRequiredClientCapabilityError({ requiredCapabilities })` — `-32021`; `data.requiredCapabilities` names exactly what the client must declare.

Match these by `code` and `data` shape when peers may run pre-brand SDK copies or hand you plain wire shapes; on brand-aware releases `instanceof` also matches across separately bundled copies of the SDK. The same check is available as an explicit static guard — `ProtocolError.isInstance(err)`, `ResourceNotFoundError.isInstance(err)` — which narrows in TypeScript and reads the same brand.

## Look up a protocol error code

`ProtocolErrorCode` is the complete vocabulary of wire codes the SDK sends and recognizes.

| Member | Code | Meaning |
| --- | --- | --- |
| `ParseError` | `-32700` | The message was not valid JSON. |
| `InvalidRequest` | `-32600` | The message was not a valid JSON-RPC request. |
| `MethodNotFound` | `-32601` | No handler is registered for the method. |
| `InvalidParams` | `-32602` | The params are wrong — also the code for a `resources/read` miss. |
| `InternalError` | `-32603` | The handler threw something other than a `ProtocolError`. |
| `ResourceNotFound` | `-32002` | Receive-tolerated only: the SDK answers a `resources/read` miss with `-32602` and never emits `-32002`. Throw `ResourceNotFoundError` instead. |
| `MissingRequiredClientCapability` | `-32021` | The request needs a capability the client did not declare. |
| `UnsupportedProtocolVersion` | `-32022` | The requested protocol version is unknown to the receiver or unsupported by it. |
| `UrlElicitationRequired` | `-32042` | The tool needs the user to visit a URL before it can complete. |

`-32021` and `-32022` are new in protocol revision 2026-07-28 — see [Protocol versions](../protocol-versions.md).

## Recap

- `isError: true` is a successful JSON-RPC result carrying a tool failure the model reads and acts on.
- A tool handler that throws produces the same `isError: true` result; the exception's `message` becomes the `content` text.
- A tool handler cannot produce a protocol error — only `UrlElicitationRequiredError` escapes.
- `ProtocolError` and its subclasses, thrown from resource, prompt, and completion callbacks, become JSON-RPC error responses the model never sees.
- `ResourceNotFoundError` and the other subclasses pick the code and pack structured `data`; match them by `code` and `data` — or, on brand-aware releases, by `instanceof`.
- The table above lists every `ProtocolErrorCode` member.
