---
status: scaffold
shape: how-to
---
# Resources

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Static + templated resources, list callbacks.
teaches: McpServer.registerResource, ResourceTemplate, ReadResourceCallback, ListResourcesCallback
source: mined from docs/server.md "Resources"
-->

## Register a static resource
<!-- teaches: registerResource (string URI overload) | salvage: docs/server.md "Resources" -->

```ts
// draft - API verified against packages/server/src/server/mcp.ts (registerResource, line 580)
server.registerResource(
  'config',
  'config://app',
  {
    title: 'Application Config',
    description: 'Application configuration data',
    mimeType: 'text/plain',
  },
  async uri => ({
    contents: [{ uri: uri.href, text: 'App configuration here' }],
  })
);
```
<!-- result: resources/list now returns config://app; resources/read on it returns the contents array. -->

## Return the contents from the read callback
<!-- teaches: ReadResourceCallback, ReadResourceResult.contents (text vs blob) | salvage: docs/server.md "Resources" -->
<!-- code: the same callback returning a text item and a base64 blob item; uri.href echoed back -->

## Add a resource template
<!-- teaches: ResourceTemplate (uriTemplate, registerResource template overload), template variables in the read callback | salvage: docs/server.md "Resources" (registerResource_template) -->
<!-- code: new ResourceTemplate('user://{userId}/profile', { list: undefined }) passed to registerResource; handler receives (uri, { userId }) -->

## List the template's instances
<!-- teaches: ListResourcesCallback (the required `list` option) | salvage: docs/server.md "Resources" (list callback) -->
<!-- code: same template with list: async () => ({ resources: [{ uri, name }, ...] }) -->
<!-- result: resources/list output showing the two concrete user:// URIs -->

## Sanitize file-backed paths
<!-- teaches: path-traversal guard for file:// resources | salvage: docs/server.md "Resources" IMPORTANT security note -->
<!-- code: resolve the requested path and reject anything that escapes the root (.. and symlinks) -->
<!-- ::: warning placeholder: never pass template variables or client URIs to filesystem APIs unchecked -->

## Tell clients when a resource changes
<!-- teaches: list_changed is automatic on (de)registration; per-resource updates live on the notifications page | salvage: docs/server.md "Change notifications" -->
<!-- code: one line - server.sendResourceListChanged(); cross-link servers/notifications.md -->

## Recap
<!-- the claims this page will prove:
- registerResource(name, uri, config, readCallback) registers a fixed-URI resource.
- The read callback returns { contents: [...] }; each item carries uri plus text or blob.
- A ResourceTemplate registers a whole URI pattern; variables arrive parsed in the callback.
- The template's list callback is what makes instances discoverable via resources/list.
- File-backed resources must reject paths that escape the root.
- Registration changes emit notifications/resources/list_changed automatically.
-->
