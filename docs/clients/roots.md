---
shape: how-to
---
# Provide roots

::: warning Deprecated — SEP-2577
Pass paths through tool arguments, resource URIs, or host configuration instead. **Roots** are deprecated as of protocol version 2026-07-28 (SEP-2577) and stay functional on 2025-era connections for at least twelve months — see the [deprecated features registry](https://modelcontextprotocol.io/specification/draft/deprecated).
:::

## Migrate away first

A **root** is a `file://` URI the client hands to the server as a boundary for its file operations. The 2026-07-28 revision deprecates the request that carries them, and nothing replaces it — give the server its paths directly.

Send the path a call should act on as a tool argument ([Tools](../servers/tools.md)), expose the locations the server owns as resources ([Resources](../servers/resources.md)), or put fixed directories in the server's own configuration. The rest of this page covers the roots API for clients that still answer 2025-era servers through the deprecation window.

## Declare the roots capability

`roots` in the `Client` constructor's `capabilities` tells the server it can ask for the list; `listChanged: true` also lets you notify it when the list changes.

```ts source="../../examples/guides/clients/roots.examples.ts#roots_capability"
import { Client } from '@modelcontextprotocol/client';

const client = new Client(
    { name: 'workspace-client', version: '1.0.0' },
    { capabilities: { roots: { listChanged: true } } }
);
```

Declare the capability before registering the handler: without it, `setRequestHandler('roots/list', …)` throws.

## Answer roots/list

`setRequestHandler('roots/list', …)` returns `{ roots }`. Every `uri` must start with `file://`; `name` is optional.

```ts source="../../examples/guides/clients/roots.examples.ts#roots_listHandler"
const roots = [
    { uri: 'file:///home/user/projects/my-app', name: 'My App' },
    { uri: 'file:///home/user/data', name: 'Data' }
];

client.setRequestHandler('roots/list', async () => {
    return { roots };
});
```

A connected server that requests `roots/list` receives exactly what the handler returned:

```
[
  { uri: 'file:///home/user/projects/my-app', name: 'My App' },
  { uri: 'file:///home/user/data', name: 'Data' }
]
```

Roots are advisory boundaries, not an access grant — the server still reaches the filesystem with its own permissions, and the SDK never enforces the list on either side.

::: info
On a 2026-07-28 connection there is no server-to-client request channel; the same handler fulfils a `roots/list` request embedded in an `input_required` result — see [Protocol versions](../protocol-versions.md).
:::

## Tell the server when the roots change

`sendRootsListChanged()` sends `notifications/roots/list_changed`; it requires the `listChanged: true` declared above.

```ts source="../../examples/guides/clients/roots.examples.ts#roots_listChanged"
roots.push({ uri: 'file:///home/user/projects/another-app', name: 'Another app' });
await client.sendRootsListChanged();
```

The notification carries no payload. A server that watches it requests `roots/list` again and receives the updated list:

```
[
  { uri: 'file:///home/user/projects/my-app', name: 'My App' },
  { uri: 'file:///home/user/data', name: 'Data' },
  {
    uri: 'file:///home/user/projects/another-app',
    name: 'Another app'
  }
]
```

## Recap

- Roots are deprecated (SEP-2577): pass paths through tool arguments, resource URIs, or configuration instead.
- `capabilities: { roots: { listChanged: true } }` on the `Client` constructor declares the capability; register the `roots/list` handler only after declaring it.
- The handler returns `{ roots }`, and every root `uri` starts with `file://`.
- Roots are advisory boundaries, not an access grant.
- `sendRootsListChanged()` notifies the server that the list changed; the server re-requests `roots/list` itself.
