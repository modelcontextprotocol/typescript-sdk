---
title: V2 API Boundary — Discussion Talking Points
status: draft — needs team sign-off before v2 ships
---

# V2 API Boundary — Discussion Talking Points

This document consolidates the open decisions from the [v2 public API plan](./v2-public-api-plan.md) into concrete talking points for the team. Each section states the current default (what the barrel files ship today), the arguments on both sides, and a recommendation.

---

## Step 3: Package.json subpath exports — `./experimental`

### Context

Both `client` and `server` already have an `exports` map in package.json with a single `.` entry. The plan proposes adding `./experimental` so that unstable features (tasks, future additions) live behind an explicit opt-in path.

### What this means for consumers

```typescript
// Stable — imports from "."
import { Client, McpServer } from '@modelcontextprotocol/client';

// Unstable — imports from "./experimental", no semver guarantee
import { InMemoryTaskStore } from '@modelcontextprotocol/server/experimental';
```

Any import path *not* in the `exports` map is a hard error at runtime and at type-check time. This makes the public/experimental boundary enforceable by the package manager, not just by convention.

### What changes

1. **tsdown config** — add `src/experimental/index.ts` as a second entry point in each published package.
2. **package.json** — add the `./experimental` subpath to the `exports` map.
3. **The existing experimental barrel files** (`packages/client/src/experimental/index.ts`, etc.) already exist — they just need to become the entry point for the subpath rather than being re-exported from `.`.

### Discussion points

| Question | Options |
|---|---|
| Do we need `./experimental` on *all* packages (client, server, node, express, hono) or just client + server? | Client + server is sufficient; middleware packages have no experimental features today. |
| Should there also be a `./internal` subpath for SDK-internal testing utilities like `InMemoryTransport`? | Useful for SDK test authors but risks consumers depending on it. Recommend: no `./internal` subpath now; if needed, document an alternative (e.g., a separate `@modelcontextprotocol/test-helpers` package). |
| Should the experimental subpath get its own changelog / deprecation policy? | Recommend: document that `./experimental` imports are "use at your own risk, may change in any release." A single line in CONTRIBUTING.md suffices. |

---

## DISCUSS Item 1: OAuth error subclasses

### Current state

The plan hides the 20 specific OAuth error classes (`InvalidGrantError`, `InvalidClientError`, etc.) and keeps only the base `OAuthError` class + the `OAUTH_ERRORS` map.

### Arguments for keeping them hidden (current default)

- **Surface reduction**: 20 fewer exported names and classes.
- **Resilience**: Matching on `error.code` is more robust than `instanceof`. If the remote server returns a code we don't have a class for, the base class still works.
- **Maintenance**: Each subclass is a semver commitment. Hiding them means we can refactor error handling internally without breaking consumers.

### Arguments for making them public

- **Ergonomics**: `catch (e) { if (e instanceof InvalidGrantError) }` is more idiomatic TypeScript than checking a string code.
- **IDE support**: Autocompletion surfaces specific classes when typing `OAuth`.

### Recommendation

**Keep hidden.** Expose the base class and teach the pattern:

```typescript
import { OAuthError } from '@modelcontextprotocol/client';

try { … }
catch (e) {
    if (e instanceof OAuthError && e.code === 'invalid_grant') { … }
}
```

If demand shows up for specific error classes in the future we can add them without a breaking change.

---

## DISCUSS Item 2: OAuth discovery functions

### Current state

These functions are hidden (not in the barrel):

- `discoverAuthorizationServerMetadata`
- `discoverOAuthProtectedResourceMetadata`
- `buildDiscoveryUrls`

### Arguments for making them public

- Advanced users building custom OAuth flows *outside* the standard `OAuthClientProvider` pattern might want to call discovery manually.
- Useful for debugging: "what does this server actually advertise?"

### Arguments for keeping them hidden

- The `OAuthClientProvider` interface + transport `authProvider` option cover the standard path. Consumers rarely need to do manual discovery.
- Making discovery functions public commits us to their signatures and the `fetch` parameter contract.
- They are thin wrappers over `fetch` — users can replicate them in 5 lines if truly needed.

### Recommendation

**Keep hidden.** If a consumer files an issue showing a concrete need, we can promote them in a minor release (non-breaking addition).

---

## DISCUSS Item 3: `AnyToolHandler` / `BaseToolCallback` generics

### Current state

The server barrel exports `ToolCallback<Args>` (the concrete handler type users assign to) but hides `BaseToolCallback<SendResultT, Extra, Args>` and `AnyToolHandler<Args>` (the union including task handlers).

### Arguments for keeping them hidden

- `ToolCallback<Args>` is what 99% of users need for `mcpServer.tool(...)`.
- The base/union generics are overload-resolution plumbing inside McpServer. Exporting them invites coupling to that internal structure.

### Arguments for making them public

- Users building tool-registry abstractions (e.g., a generic `registerAll(tools: Map<string, AnyToolHandler<…>>)`) need the union type.
- Without exporting `AnyToolHandler`, consumers have to use `typeof` gymnastics to type tool handlers generically.

### Recommendation

**Keep hidden for now.** If the tool-registry use case comes up we can export `AnyToolHandler` later (additive, non-breaking). The current barrel export of `ToolCallback<Args>` covers the overwhelmingly common case.

---

## DISCUSS Item 4: Per-method request types

### Current state

The barrel exports per-method *result* types (`CallToolResult`, `ListToolsResult`, …) but not per-method *request* types (`CallToolRequest`, `ListToolsRequest`, …).

### Why result types are exported but request types are not

When a user registers a low-level handler:

```typescript
server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    // `request` is already typed to the params — no need to import CallToolRequest
    return { content: [{ type: 'text', text: 'hello' }] };
});
```

The request type (`CallToolRequest`) is the full JSON-RPC envelope (`{ method, params }`). The handler receives just the *params*. So consumers rarely need the envelope type.

Result types are different — users *construct* them as return values, so they benefit from explicit type annotations:

```typescript
const result: CallToolResult = { content: … };
```

### Arguments for exporting request types anyway

- Symmetry. Having results without requests feels incomplete.
- Some users might want to type intermediate variables or helper functions that pass around the full request.

### Arguments against

- Adds 16 more exported names for a use case that barely exists.
- The params type is accessible as `Parameters<typeof handler>[0]` if truly needed.

### Recommendation

**Keep request types hidden.** Export request *schemas* (for `setRequestHandler`) and result *types* (for return values). That's the minimal surface that matches actual usage.

---

## Summary table

| Item | Current default | Recommendation | Risk if wrong |
|---|---|---|---|
| `./experimental` subpath | Not yet added | **Add it** (low-effort, high-value gate) | None — purely additive |
| OAuth error subclasses | Hidden | **Stay hidden** | Minor ergonomics loss; easily fixable later |
| OAuth discovery functions | Hidden | **Stay hidden** | Advanced auth users may need to work around; additive fix is easy |
| `AnyToolHandler` / `BaseToolCallback` | Hidden | **Stay hidden** | Tool-registry authors need a workaround; additive fix is easy |
| Per-method request types | Hidden | **Stay hidden** | Symmetry feels incomplete; no real user impact |
