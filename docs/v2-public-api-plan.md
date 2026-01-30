---
title: V2 Public API Boundary Plan
status: draft
---

# V2 Public API Boundary Plan

## Problem

In v1 the SDK exported nearly every symbol from every module — classes, schemas, utilities, internal helpers — all at the same level. This made every internal refactor a potential breaking change from semver's perspective, even when no consumer was affected. The result: maintenance burden from backwards-compat shims, slow iteration, and a bloated developer experience where `import { … } from '@modelcontextprotocol/client'` surfaces hundreds of names.

## Goal

For v2 we adopt **private by default**: enumerate the full current surface, assume everything is internal, then deliberately promote only the symbols consumers need. Everything else is hidden — either by not exporting it from the barrel file, by restricting it to an `internal` or `experimental` subpath export, or by marking it `@internal` for tooling enforcement.

---

## Recommended Tooling

### 1. `@microsoft/api-extractor` (recommended primary tool)

This is the gold-standard for exactly this problem. It:

- Generates an **API report** (`.api.md`) that lists the entire public surface in a canonical format. This file is committed to the repo and reviewed in PRs — any unintended public surface change shows up as a diff.
- Strips members tagged `/** @internal */` from the emitted `.d.ts` files, so they are invisible to downstream consumers even if they appear in source.
- Provides a `--local` CI mode that fails the build when the API report diverges.
- Works natively with monorepo layouts.

Setup is roughly:

```
pnpm add -D @microsoft/api-extractor @microsoft/api-extractor-core
```

Then one `api-extractor.json` per package, a `rollup` step that produces the API report, and a CI check that diffs it.

### 2. Package.json subpath exports (enforcement layer)

Node.js and bundlers already respect the `exports` map. We can use it to create explicit, stable entry points and block everything else:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "types": "./dist/index.d.ts"
    },
    "./experimental": {
      "import": "./dist/experimental.mjs",
      "types": "./dist/experimental.d.ts"
    }
  }
}
```

Any import path not listed here is a hard error at runtime and at type-check time. This gives a second enforcement layer on top of api-extractor.

### 3. `@internal` JSDoc tag convention

Throughout source code, tag anything not intended to be public:

```typescript
/** @internal */
export function serializeMessage(msg: JSONRPCMessage): string { … }
```

api-extractor will strip these from the rollup `.d.ts`. For code that does not yet go through api-extractor, this tag serves as a lint-searchable signal of intent.

### 4. Reference: how other large SDKs do it

- **Anthropic's own `@anthropic-ai/sdk`** uses api-extractor + api-report files.
- **`@azure/identity`** uses subpath exports + `@internal` tags + api-extractor.
- **`tsd`** (test type definitions) can be added later to assert that internal symbols are truly invisible in the built output.

---

## Enumeration & Decisions

The sections below walk every package. Each symbol is labelled:

| Label | Meaning |
|---|---|
| `PUBLIC` | Exported from the main `.` entry point, part of the stable API |
| `INTERNAL` | Not exported from `.`; available only via `./internal` subpath or not exported at all |
| `EXPERIMENTAL` | Exported from `./experimental` subpath, explicitly unstable |
| `DISCUSS` | Needs a team decision before we lock the boundary |

---

### `@modelcontextprotocol/core`

Core is consumed indirectly — both `client` and `server` re-export it. The question is *which* core symbols each package promotes to its own public surface.

#### Classes

| Symbol | Decision | Rationale |
|---|---|---|
| `McpError` | `PUBLIC` | Users catch and inspect this everywhere |
| `UrlElicitationRequiredError` | `PUBLIC` | Thrown by elicitation flows |
| `OAuthError` + all subclasses (20 classes) | `DISCUSS` | Expose `OAuthError` base + `OAUTH_ERRORS` map as `PUBLIC`; hide the 20 specific subclasses as `INTERNAL`. Consumers should match on `error.code`, not `instanceof InvalidGrantError`. |
| `ReadBuffer` | `INTERNAL` | stdio parsing detail |
| `UriTemplate` | `PUBLIC` | Used by consumers building `ResourceTemplate` instances |
| `InMemoryTransport` | `INTERNAL` | Testing helper — re-export from a `./testing` subpath if needed |
| `InMemoryTaskStore` | `EXPERIMENTAL` | Only relevant for task-backed servers |
| `InMemoryTaskMessageQueue` | `EXPERIMENTAL` | Same |

#### Interfaces

| Symbol | Decision | Rationale |
|---|---|---|
| `Transport` | `PUBLIC` | Users who implement custom transports need this |
| `AuthInfo` | `PUBLIC` | Passed in `RequestHandlerExtra`; users read it in handlers |
| `RequestInfo` | `PUBLIC` | Same as AuthInfo — available in handler extra |
| `MessageExtraInfo` | `INTERNAL` | SDK wiring detail between transport and protocol |
| `TaskStore` | `EXPERIMENTAL` | Only for task feature |
| `TaskMessageQueue` | `EXPERIMENTAL` | Same |
| `EventStore` | `PUBLIC` | Users implement this for SSE replay on `WebStandardStreamableHTTPServerTransport` |

#### Types (inferred from Zod schemas)

The type layer is split into two groups:

**Group A — Types users construct or consume in handlers (PUBLIC):**

`Tool`, `Resource`, `ResourceTemplate` (the type, not the class), `Prompt`, `PromptArgument`, `PromptMessage`, `TextContent`, `ImageContent`, `AudioContent`, `ToolUseContent`, `ToolResultContent`, `EmbeddedResource`, `ResourceLink`, `ContentBlock`, `TextResourceContents`, `BlobResourceContents`, `SamplingMessage`, `SamplingContent`, `ModelHint`, `ModelPreferences`, `ToolChoice`, `CreateMessageRequestParams`, `CreateMessageResult`, `ElicitRequestParams`, `ElicitResult`, `Root`, `LoggingLevel`, `LoggingMessageNotification`, `Implementation`, `ClientCapabilities`, `ServerCapabilities`, `ToolAnnotations`, `ToolExecution`, `AuthInfo`, `Role`

**Group B — Protocol-layer types (INTERNAL unless needed for low-level handler registration):**

Everything else in types.ts: `JSONRPCRequest`, `JSONRPCNotification`, `JSONRPCResponse`, `JSONRPCMessage`, `ProgressToken`, `Cursor`, `RequestId`, `RequestParams`, `NotificationParams`, `RequestMeta`, `TaskAugmentedRequestParams`, all the per-method request/result types (`ListToolsRequest`, `CallToolRequest`, `CallToolResult`, `ListToolsResult`, `GetPromptRequest`, `ListResourcesResult`, etc.)

> **Exception**: The request/result types that users return from `setRequestHandler` callbacks should be `PUBLIC`. Specifically: `CallToolResult`, `ListToolsResult`, `GetPromptResult`, `ListPromptsResult`, `ReadResourceResult`, `ListResourcesResult`, `ListResourceTemplatesResult`, `CompleteResult`, `CreateMessageResult`, `ElicitResult`, `ListRootsResult`. The corresponding *request* types (`CallToolRequest`, etc.) are needed less often because `setRequestHandler` gives you the typed params directly — mark them `DISCUSS`.

**Group C — Enum types (PUBLIC):**

`ErrorCode`, `Role`, `LoggingLevel`

#### Zod Schemas

This is the largest group and the most impactful decision. Currently ~100 schemas are exported.

**Decision: schemas are `INTERNAL` by default.** The rationale:

1. Most consumers never validate protocol messages themselves — the SDK does it.
2. The schema objects pull in Zod as a dependency surface; hiding them decouples the SDK's internal validation implementation from consumer code.
3. The few schemas users need are exactly those passed to `setRequestHandler()` on the low-level `Server`/`Client`. For these we export a curated set.

**PUBLIC schemas** (needed for `setRequestHandler` first argument):

`CallToolRequestSchema`, `ListToolsRequestSchema`, `GetPromptRequestSchema`, `ListPromptsRequestSchema`, `ReadResourceRequestSchema`, `ListResourcesRequestSchema`, `ListResourceTemplatesRequestSchema`, `SubscribeRequestSchema`, `UnsubscribeRequestSchema`, `SetLevelRequestSchema`, `CompleteRequestSchema`, `PingRequestSchema`, `InitializeRequestSchema`, `CreateMessageRequestSchema`, `ElicitRequestSchema`, `ListRootsRequestSchema`

Plus the result schemas that users may want to validate responses against:

`CallToolResultSchema`, `ListToolsResultSchema`, `GetPromptResultSchema`, `ListPromptsResultSchema`, `ReadResourceResultSchema`, `ListResourcesResultSchema`, `ListResourceTemplatesResultSchema`, `CompleteResultSchema`, `CreateMessageResultSchema`, `ElicitResultSchema`, `ListRootsResultSchema`

**Everything else** — `ProgressTokenSchema`, `CursorSchema`, `RequestIdSchema`, `JSONRPCRequestSchema`, `JSONRPCNotificationSchema`, `JSONRPCMessageSchema`, all the sub-component schemas, notification schemas, the task schemas, etc. — becomes `INTERNAL`.

#### Functions & Utilities

| Symbol | Decision | Rationale |
|---|---|---|
| `isJSONRPCRequest` | `INTERNAL` | Protocol routing detail |
| `isJSONRPCNotification` | `INTERNAL` | Same |
| `isJSONRPCResultResponse` | `INTERNAL` | Same |
| `isJSONRPCErrorResponse` | `INTERNAL` | Same |
| `isInitializeRequest` | `INTERNAL` | Same |
| `isInitializedNotification` | `INTERNAL` | Same |
| `isTaskAugmentedRequestParams` | `EXPERIMENTAL` | Only for task feature |
| `assertCompleteRequestPrompt` | `PUBLIC` | Used in `CompleteRequest` handlers to narrow the type |
| `assertCompleteRequestResourceTemplate` | `PUBLIC` | Same |
| `deserializeMessage` | `INTERNAL` | stdio parsing detail |
| `serializeMessage` | `INTERNAL` | Same |
| `normalizeHeaders` | `INTERNAL` | Transport detail |
| `createFetchWithInit` | `INTERNAL` | Transport detail |
| `resourceUrlFromServerUrl` | `INTERNAL` | Auth plumbing |
| `checkResourceAllowed` | `INTERNAL` | Auth plumbing |
| `getDisplayName` | `INTERNAL` | UI helper, trivial to inline |
| `validateToolName` / `issueToolNameWarning` / `validateAndWarnToolName` | `INTERNAL` | SDK auto-warns on registration; consumers don't call these |
| `mergeCapabilities` | `INTERNAL` | Protocol init detail |
| `toArrayAsync` / `takeResult` | `EXPERIMENTAL` | Task streaming helpers |
| `safeParse` / `safeParseAsync` (zod-compat) | `INTERNAL` | SDK validation plumbing |
| `objectFromShape` / `getObjectShape` / `normalizeObjectSchema` | `INTERNAL` | Tool schema conversion detail |
| `toJsonSchemaCompat` | `INTERNAL` | Converts Zod → JSON Schema for the wire; an implementation detail |
| `getMethodLiteral` | `INTERNAL` | Protocol routing detail |
| `parseWithCompat` | `INTERNAL` | Same |
| `getParseErrorMessage` / `getSchemaDescription` / `isSchemaOptional` / `getLiteralValue` | `INTERNAL` | Zod compat internals |

#### Constants

| Symbol | Decision | Rationale |
|---|---|---|
| `LATEST_PROTOCOL_VERSION` | `PUBLIC` | Consumers may log or assert the version |
| `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` | `INTERNAL` | Negotiation detail |
| `SUPPORTED_PROTOCOL_VERSIONS` | `INTERNAL` | SDK manages this |
| `JSONRPC_VERSION` | `INTERNAL` | Always `'2.0'`; SDK detail |
| `RELATED_TASK_META_KEY` | `EXPERIMENTAL` | Task feature |
| `DEFAULT_REQUEST_TIMEOUT_MSEC` | `PUBLIC` | Consumers may want to know the default |
| `OAUTH_ERRORS` | `DISCUSS` | See OAuth error classes discussion above |
| `COMPLETABLE_SYMBOL` | `INTERNAL` | Symbol-based tagging detail |

#### Validation

| Symbol | Decision | Rationale |
|---|---|---|
| `AjvJsonSchemaValidator` | `PUBLIC` | Users may pass a custom validator to `McpServer`/`Client` |
| `CfWorkerJsonSchemaValidator` | `PUBLIC` | Same, for CF Workers |
| `JsonSchemaValidator` type | `PUBLIC` | The interface for custom validators |
| `JsonSchemaValidatorResult` type | `PUBLIC` | Return type of validators |
| `JsonSchemaType` type | `INTERNAL` | Internal schema representation |

---

### `@modelcontextprotocol/client`

#### Classes

| Symbol | Decision | Rationale |
|---|---|---|
| `Client` | `PUBLIC` | The primary client entry point |
| `StdioClientTransport` | `PUBLIC` | Primary transport for local servers |
| `StreamableHTTPClientTransport` | `PUBLIC` | Primary transport for remote servers |
| `SSEClientTransport` | `PUBLIC` | Legacy but needed for interop |
| `WebSocketClientTransport` | `PUBLIC` | Alternative transport |
| `UnauthorizedError` | `PUBLIC` | Thrown by auth flows |
| `SseError` | `INTERNAL` | Transport implementation detail |
| `StreamableHTTPError` | `PUBLIC` | Thrown by the recommended transport |
| `ClientCredentialsProvider` | `PUBLIC` | OAuth provider users instantiate |
| `PrivateKeyJwtProvider` | `PUBLIC` | Same |
| `StaticPrivateKeyJwtProvider` | `PUBLIC` | Same |
| `ExperimentalClientTasks` | `EXPERIMENTAL` | Accessed via `client.experimental.tasks` |

#### Interfaces & Types

| Symbol | Decision | Rationale |
|---|---|---|
| `OAuthClientProvider` | `PUBLIC` | Users implement this for custom OAuth flows |
| `ClientOptions` | `PUBLIC` | Passed to `new Client()` |
| `RequestOptions` | `PUBLIC` | Passed to every client method (`options` param) |
| `StdioServerParameters` | `PUBLIC` | Passed to `StdioClientTransport` constructor |
| `StreamableHTTPClientTransportOptions` | `PUBLIC` | Transport config |
| `StreamableHTTPReconnectionOptions` | `PUBLIC` | Part of transport config |
| `SSEClientTransportOptions` | `PUBLIC` | Legacy transport config |
| `StartSSEOptions` | `INTERNAL` | SSE implementation detail |
| `AddClientAuthentication` | `INTERNAL` | Auth plumbing type |
| `AuthResult` | `INTERNAL` | Auth flow return |
| `Middleware` type | `PUBLIC` | Users compose fetch middleware |
| `RequestLogger` | `PUBLIC` | Logging middleware callback |
| `LoggingOptions` | `PUBLIC` | `withLogging()` config |
| `DEFAULT_INHERITED_ENV_VARS` | `PUBLIC` | Users may want to extend this list |

#### Functions

| Symbol | Decision | Rationale |
|---|---|---|
| `auth()` | `INTERNAL` | Called internally by transports; advanced users use `OAuthClientProvider` instead |
| `withOAuth` | `PUBLIC` | Fetch middleware users compose |
| `withLogging` | `PUBLIC` | Same |
| `applyMiddlewares` | `PUBLIC` | Same |
| `createMiddleware` | `PUBLIC` | Same |
| `createPrivateKeyJwtAuth` | `PUBLIC` | Factory for JWT auth |
| `selectClientAuthMethod` | `INTERNAL` | Auth negotiation detail |
| `parseErrorResponse` | `INTERNAL` | Auth plumbing |
| `isHttpsUrl` | `INTERNAL` | Auth validation |
| `selectResourceURL` | `INTERNAL` | Auth plumbing |
| `extractWWWAuthenticateParams` | `INTERNAL` | Auth plumbing |
| `extractResourceMetadataUrl` | `INTERNAL` | Auth plumbing |
| `discoverOAuthProtectedResourceMetadata` | `DISCUSS` | Might be needed by advanced auth users |
| `discoverOAuthMetadata` | `DISCUSS` | Same |
| `buildDiscoveryUrls` | `INTERNAL` | Auth plumbing |
| `discoverAuthorizationServerMetadata` | `DISCUSS` | Same |
| `startAuthorization` | `INTERNAL` | Auth step detail |
| `prepareAuthorizationCodeRequest` | `INTERNAL` | Same |
| `exchangeAuthorization` | `INTERNAL` | Same |
| `refreshAuthorization` | `INTERNAL` | Same |
| `fetchToken` | `INTERNAL` | Same |
| `registerClient` | `INTERNAL` | Same |
| `getDefaultEnvironment` | `PUBLIC` | Used when configuring `StdioClientTransport` |
| `getSupportedElicitationModes` | `INTERNAL` | Protocol capability helper |

---

### `@modelcontextprotocol/server`

#### Classes

| Symbol | Decision | Rationale |
|---|---|---|
| `McpServer` | `PUBLIC` | The recommended high-level server API |
| `Server` | `PUBLIC` | Low-level alternative; users who need `setRequestHandler` need this |
| `ResourceTemplate` | `PUBLIC` | Users instantiate this for dynamic resources |
| `StdioServerTransport` | `PUBLIC` | Primary transport for spawned servers |
| `WebStandardStreamableHTTPServerTransport` | `PUBLIC` | Primary transport for HTTP servers |
| `ExperimentalServerTasks` | `EXPERIMENTAL` | Via `server.experimental.tasks` |
| `ExperimentalMcpServerTasks` | `EXPERIMENTAL` | Via `mcpServer.experimental.tasks` |

#### Interfaces & Types

| Symbol | Decision | Rationale |
|---|---|---|
| `ServerOptions` | `PUBLIC` | Passed to `new Server()` / `new McpServer()` |
| `RegisteredTool` | `PUBLIC` | Returned by `mcpServer.registerTool()` |
| `RegisteredResource` | `PUBLIC` | Returned by `mcpServer.registerResource()` |
| `RegisteredResourceTemplate` | `PUBLIC` | Same |
| `RegisteredPrompt` | `PUBLIC` | Returned by `mcpServer.registerPrompt()` |
| `ToolCallback` | `PUBLIC` | Users type their tool handlers against this |
| `PromptCallback` | `PUBLIC` | Same for prompts |
| `ReadResourceCallback` | `PUBLIC` | Same for resources |
| `ReadResourceTemplateCallback` | `PUBLIC` | Same |
| `ListResourcesCallback` | `PUBLIC` | Same |
| `ResourceMetadata` | `PUBLIC` | Config shape for resources |
| `CompleteResourceTemplateCallback` | `PUBLIC` | Completion callback for resource templates |
| `CompleteCallback` (completable.ts) | `PUBLIC` | Completion callback for `completable()` |
| `CompletableMeta` / `CompletableDef` | `INTERNAL` | Implementation detail of `completable()` |
| `CompletableSchema` | `INTERNAL` | Same |
| `AnyToolHandler` / `BaseToolCallback` | `DISCUSS` | Generics that may leak complexity; see if users need them |
| `EventStore` | `PUBLIC` | Users implement for SSE replay |
| `WebStandardStreamableHTTPServerTransportOptions` | `PUBLIC` | Transport config |
| `HandleRequestOptions` | `PUBLIC` | Passed to `handleRequest()` |
| `StreamId` / `EventId` | `INTERNAL` | Transport detail types |
| `HostHeaderValidationResult` | `INTERNAL` | Middleware return type; consumed internally |
| `McpZodTypeKind` enum | `INTERNAL` | completable() tagging detail |
| `CreateTaskRequestHandler` / `TaskRequestHandler` / `ToolTaskHandler` | `EXPERIMENTAL` | Task feature types |

#### Functions

| Symbol | Decision | Rationale |
|---|---|---|
| `completable()` | `PUBLIC` | Users wrap Zod schemas with this for auto-completion |
| `isCompletable()` | `INTERNAL` | SDK uses this to detect wrapped schemas |
| `getCompleter()` | `INTERNAL` | Same |
| `unwrapCompletable()` | `INTERNAL` | Same |
| `validateHostHeader` | `INTERNAL` | Middleware plumbing |
| `localhostAllowedHostnames` | `PUBLIC` | Useful when configuring host validation |
| `hostHeaderValidationResponse` | `PUBLIC` | Useful for custom middleware integrations |

---

### Middleware Packages (`express`, `hono`, `node`)

These are thin and mostly fine as-is. Decisions:

| Symbol | Package | Decision | Rationale |
|---|---|---|---|
| `createMcpExpressApp` | express | `PUBLIC` | Main entry point |
| `hostHeaderValidation` | express | `PUBLIC` | Middleware users compose |
| `localhostHostValidation` | express | `PUBLIC` | Same |
| `CreateMcpExpressAppOptions` | express | `PUBLIC` | Config type |
| `createMcpHonoApp` | hono | `PUBLIC` | Main entry point |
| `hostHeaderValidation` | hono | `PUBLIC` | Same |
| `localhostHostValidation` | hono | `PUBLIC` | Same |
| `CreateMcpHonoAppOptions` | hono | `PUBLIC` | Same |
| `NodeStreamableHTTPServerTransport` | node | `PUBLIC` | Main Node.js transport |
| `StreamableHTTPServerTransportOptions` | node | `PUBLIC` | Config type alias |

---

### `Protocol` base class (core)

The abstract `Protocol` class is a special case. Consumers should never subclass it directly — they use `Client` or `Server`. But some of its public methods (like `setRequestHandler`, `request`, `connect`, `close`) are inherited and therefore visible on the public classes.

**Decision:**
- Do not export `Protocol` as a named export from any package barrel.
- Methods that appear on `Client` or `Server` are implicitly public through those classes.
- `ProtocolOptions` type is `PUBLIC` (it's part of `ClientOptions`/`ServerOptions`).
- `RequestHandlerExtra` type is `PUBLIC` (users receive it in every handler callback and read `signal`, `sessionId`, `authInfo`, `sendNotification`, `sendRequest` from it).
- `RequestOptions` / `NotificationOptions` types are `PUBLIC` (passed to client methods).
- `ProgressCallback` type is `PUBLIC` (used in `RequestOptions.onprogress`).
- `RequestTaskStore` type is `EXPERIMENTAL` (only for task feature).
- `DEFAULT_REQUEST_TIMEOUT_MSEC` is `PUBLIC`.
- `mergeCapabilities` is `INTERNAL`.

---

## Patterns That Create API Surface Creep (Watch For)

1. **Re-exporting everything from core in client/server barrels.** Currently both `client` and `server` do `export * from '@modelcontextprotocol/core'`. For v2, replace with explicit named exports of only the `PUBLIC` symbols listed above.

2. **Exporting every class/function defined in a module.** Many files export helpers that are only called by other SDK files. Mark them `@internal` or simply don't re-export them from the barrel.

3. **Zod schemas as public surface.** Schemas are validation objects — they are an implementation detail. Export the *types* (via `type X = Infer<typeof XSchema>`) publicly; keep the schema objects internal except where `setRequestHandler` needs them.

4. **Error subclass proliferation.** 20 OAuth error subclasses are implementation details. Expose the base class and let consumers branch on `error.code`.

5. **Type utilities leaking.** Functions like `safeParse`, `objectFromShape`, `normalizeObjectSchema` exist to abstract Zod v3/v4 differences inside the SDK. They have no reason to be public.

---

## Implementation Steps

1. **Add api-extractor config** to each published package (`packages/core`, `packages/client`, `packages/server`, the three middleware packages). Generate initial API reports so we have a baseline snapshot of today's surface.

2. **Tighten barrel files.** Replace `export *` with explicit `export { … }` lists that match the `PUBLIC` decisions above. This is the single highest-leverage change.

3. **Restrict `exports` in package.json.** Add `./experimental` subpath for experimental symbols. Consider `./internal` for symbols that SDK-internal packages need to share (e.g., core internals consumed by client/server during their build).

4. **Tag internals.** Add `/** @internal */` JSDoc to every symbol marked `INTERNAL` in this plan. This makes api-extractor strip them from `.d.ts` and makes intent searchable via grep.

5. **Add a CI check.** Run `api-extractor run --local` in CI. Fail the build if the API report changes without an explicit update.

6. **Write a `CONTRIBUTING.md` section** on how to promote a symbol to public: open a discussion, update the API plan, get sign-off, then update the barrel export and API report.

7. **Resolve the `DISCUSS` items** before shipping v2. The open items are:
    - OAuth error classes: base-only vs full set?
    - OAuth discovery functions: public for advanced auth users?
    - `AnyToolHandler` / `BaseToolCallback` generics: needed or too leaky?
    - Per-method request types (e.g., `CallToolRequest`): public or only the result types?

---

## Quick Reference: What a v2 consumer imports

```typescript
// Server — the common path
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server';
import { completable } from '@modelcontextprotocol/server';
import type { Tool, TextContent, RegisteredTool } from '@modelcontextprotocol/server';

// Client — the common path
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Tool, PromptMessage } from '@modelcontextprotocol/client';

// Middleware
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';

// Experimental (opt-in subpath, no stability promise)
import { InMemoryTaskStore } from '@modelcontextprotocol/server/experimental';
```

Nothing else should be reachable.
