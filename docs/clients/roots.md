---
status: scaffold
shape: how-to
---
# Provide roots

::: warning Deprecated — SEP-2577
<!-- SUNSET BANNER placeholder. Roots are deprecated as of protocol version 2026-07-28
(SEP-2577) and remain functional for at least twelve months. Migration target named
FIRST: pass paths via tool arguments, resource URIs, or host configuration instead.
Link the deprecated-features registry. This banner is the first thing on the page. -->
:::

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Provide roots — SUNSET-FRAMED (SEP-2577), banner at top.
teaches: roots capability, client.setRequestHandler('roots/list'), Client.sendRootsListChanged
source: mined from docs/client.md "Roots"
-->

## Migrate away first

<!-- teaches: the replacement, not the feature. Name the targets (tool arguments, resource URIs, configuration) before showing any roots API | salvage: docs/client.md "Roots" warning block; net-new framing -->
<!-- code: none — this section is the off-ramp; one link to the deprecated-features registry -->

## Declare the roots capability

<!-- teaches: roots: { listChanged: true } in the Client constructor's capabilities option | salvage: docs/client.md "Handling server-initiated requests" (capabilities_declaration) -->
<!-- code: new Client(info, { capabilities: { roots: { listChanged: true } } }) -->

## Answer roots/list

<!-- teaches: client.setRequestHandler('roots/list', ...) returning { roots } | salvage: docs/client.md "Roots" -->

```ts
// draft - API verified against packages/client/src/client/client.ts (setRequestHandler) and the roots/list request type (a ServerRequest — the server sends it) in packages/core-internal/src/types/types.ts
client.setRequestHandler('roots/list', async () => {
  return {
    roots: [
      { uri: 'file:///home/user/projects/my-app', name: 'My App' },
      { uri: 'file:///home/user/data', name: 'Data' },
    ],
  };
});
```

<!-- result: a server that declares it uses roots receives this list and scopes its file operations to it. -->

## Tell the server when the roots change

<!-- teaches: Client.sendRootsListChanged | salvage: docs/client.md "Roots" (final paragraph) -->
<!-- code: await client.sendRootsListChanged() after the handler's backing list changes -->

## Recap

<!-- the claims this page will prove:
- Roots are deprecated (SEP-2577); the migration targets are tool arguments, resource URIs, and configuration.
- While you still need them: declare roots: { listChanged: true } and register a roots/list handler returning { roots }.
- sendRootsListChanged() tells the server to re-list.
-->
