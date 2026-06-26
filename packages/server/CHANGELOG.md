# @modelcontextprotocol/server

## 2.0.0-alpha.3

### Major Changes

- [#2128](https://github.com/modelcontextprotocol/typescript-sdk/pull/2128) [`c8d7401`](https://github.com/modelcontextprotocol/typescript-sdk/commit/c8d7401b46f34b6c49b7cfb7b321714d0d4048f6) Thanks [@felixweinberger](https://github.com/felixweinberger)! - SEP-2663: remove
  2025-11 experimental tasks (TaskManager, experimental.tasks.\* accessors). Tasks are now Extensions Track.

### Minor Changes

- [#1974](https://github.com/modelcontextprotocol/typescript-sdk/pull/1974) [`db83829`](https://github.com/modelcontextprotocol/typescript-sdk/commit/db83829c5bd5d6659c5e7b96638b11953b0e262d) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add custom (non-spec)
  method support: a 3-arg `setRequestHandler(method, schemas, handler)` / `setNotificationHandler(method, schemas, handler)` form for vendor-prefixed methods, and a `request(req, resultSchema)` overload (also on `ctx.mcpReq.send`) for typed custom-method results. Spec-method
  calls are unchanged.

    Response result-schema validation failure now rejects with `SdkError(InvalidResult)` instead of a raw `ZodError`. Adds `SdkErrorCode.InvalidResult`.

- [#2353](https://github.com/modelcontextprotocol/typescript-sdk/pull/2353) [`c59dc3a`](https://github.com/modelcontextprotocol/typescript-sdk/commit/c59dc3aa1a633d27fbbe873f1a430483cf7440f8) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Support `icons` on the
  high-level `McpServer.registerTool()` and `registerPrompt()` config objects (and on their `update()` methods). Tool and prompt icons now surface in `tools/list` and `prompts/list`. Resource, resource-template, and server-info (`Implementation`) icons already passed through.
  This closes the gap with the MCP spec, which allows `icons` on tools, resources, resource templates, and prompts.

- [#2354](https://github.com/modelcontextprotocol/typescript-sdk/pull/2354) [`0fb8406`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0fb8406d83a3578a12a605e1b43c352d565071b1) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Add the v2
  `IdJagTokenExchangeResponse` type to the public API and register its schema as an MCP spec type. `IdJagTokenExchangeResponse` is now exported from `@modelcontextprotocol/client` and `@modelcontextprotocol/server`, `'IdJagTokenExchangeResponse'` joins the `SpecTypeName` union,
  and `isSpecType.IdJagTokenExchangeResponse(value)` / `specTypeSchemas.IdJagTokenExchangeResponse` validate it by name — matching how the OAuth/OpenID auth schemas are already exposed. The Zod schema itself, `IdJagTokenExchangeResponseSchema`, is available from
  `@modelcontextprotocol/core`.

- [#2248](https://github.com/modelcontextprotocol/typescript-sdk/pull/2248) [`db28156`](https://github.com/modelcontextprotocol/typescript-sdk/commit/db28156a23032290b3ce3bae00a17544c4807b8f) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Restore the 2025-11-25
  task wire types that were removed together with the task feature: the task schemas and inferred types, task members of the request/result/notification unions, the `task` request-params augmentation, the `tasks` capability key, the `isTaskAugmentedRequestParams` guard, and
  `RELATED_TASK_META_KEY`. The task feature itself remains removed — servers do not advertise the `tasks` capability and inbound `tasks/*` requests receive `-32601` — but the wire surface stays so SDKs interoperate cleanly with peers on the 2025-11-25 revision.

- [#1887](https://github.com/modelcontextprotocol/typescript-sdk/pull/1887) [`96db044`](https://github.com/modelcontextprotocol/typescript-sdk/commit/96db044fe965f0b7d5109e6d68598eaddce961c9) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Export `isSpecType` and
  `specTypeSchemas` records for runtime validation of any MCP spec type by name. `isSpecType.ContentBlock(value)` is a type predicate; `specTypeSchemas.ContentBlock` is a `StandardSchemaV1Sync<ContentBlock>` validator — `validate()` returns the result synchronously. Guards are
  standalone functions, so `arr.filter(isSpecType.ContentBlock)` works. Also export the `SpecTypeName`, `SpecTypes`, and `StandardSchemaV1Sync` types.

- [#1871](https://github.com/modelcontextprotocol/typescript-sdk/pull/1871) [`9fc9070`](https://github.com/modelcontextprotocol/typescript-sdk/commit/9fc9070b7b8e18227127aaee9869f8809a87fdb1) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Move stdio transports
  to a `./stdio` subpath export. Import `StdioClientTransport`, `getDefaultEnvironment`, `DEFAULT_INHERITED_ENV_VARS`, and `StdioServerParameters` from `@modelcontextprotocol/client/stdio`, and `StdioServerTransport` from `@modelcontextprotocol/server/stdio`. The
  `@modelcontextprotocol/client` root entry no longer pulls in `node:child_process`, `node:stream`, or `cross-spawn`, fixing bundling for browser and Cloudflare Workers targets; the `@modelcontextprotocol/server` root entry drops its `node:stream` reference. Node.js, Bun, and
  Deno consumers update the import path; runtime behavior is unchanged.

### Patch Changes

- [#2280](https://github.com/modelcontextprotocol/typescript-sdk/pull/2280) [`e8c7180`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e8c7180109b417eef5cc22b7e9d821ab1c119a69) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Bound the
  protocol-version checks gating SSE resumability behavior (priming events and `closeSSEStream` callbacks) in the Streamable HTTP server transport. Previously an open-ended `>= '2025-11-25'` comparison let unknown future protocol version strings from an `initialize` request body
  enable this behavior; the version must now also be one of the transport's supported protocol versions. Behavior for all currently supported protocol versions is unchanged.

- [#1897](https://github.com/modelcontextprotocol/typescript-sdk/pull/1897) [`434b2f1`](https://github.com/modelcontextprotocol/typescript-sdk/commit/434b2f11ecec452f3dca0199f68afccd8b119dd4) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Stop bundling
  `@cfworker/json-schema` into the main package barrel. Previously `CfWorkerJsonSchemaValidator` was re-exported from the core internal barrel, so tsdown inlined the `@cfworker/json-schema` dependency into every consumer's bundle even when it was never used. The named validator
  classes are now reachable only via the explicit `@modelcontextprotocol/{client,server}/validators/{ajv,cf-worker}` subpaths and the runtime `_shims` conditional, so consumers that import only from the root entry point no longer ship the validator dep.

- [#2269](https://github.com/modelcontextprotocol/typescript-sdk/pull/2269) [`e84c3e9`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e84c3e9ad040eb09299b1f99dd8bdd14251ae790) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Non-SEP draft spec conformance
  fixes
    - `McpServer` now eagerly installs list/read/call handlers for every primitive capability (`tools`, `resources`, `prompts`) declared in `ServerOptions.capabilities`. Per the draft spec, a server that declares a capability MUST respond to its list method (potentially with an
      empty result) instead of returning "Method not found". Previously, handlers were only installed lazily on first registration, so a server constructed with e.g. `capabilities: { tools: {} }` and zero registered tools answered `tools/list` with `-32601`. Low-level `Server`
      users remain responsible for registering handlers for declared capabilities (documented on `ServerOptions.capabilities`).
    - Fixed pagination doc examples on `Client.listTools`/`listPrompts`/`listResources` to loop `while (cursor !== undefined)` instead of `while (cursor)` — per the draft spec, clients MUST NOT treat an empty-string cursor as the end of results.

- [#1834](https://github.com/modelcontextprotocol/typescript-sdk/pull/1834) [`42cb6b2`](https://github.com/modelcontextprotocol/typescript-sdk/commit/42cb6b2b728347d8b58a0d1940b7e63366a29ab9) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Export
  `InMemoryTransport` for in-process testing.

- [#1788](https://github.com/modelcontextprotocol/typescript-sdk/pull/1788) [`df4b6cc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/df4b6cc88d6f24fc857519cf506a7a039f532637) Thanks [@claygeo](https://github.com/claygeo)! - Prevent stack overflow in
  StreamableHTTPServerTransport.close() with re-entrant guard

- [#1855](https://github.com/modelcontextprotocol/typescript-sdk/pull/1855) [`2c0c481`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2c0c481cb9dbfd15c8613f765c940a5f5bace94d) Thanks [@Christian-Sidak](https://github.com/Christian-Sidak)! - Add `| undefined` to
  optional callback and function properties on `WebStandardStreamableHTTPServerTransportOptions` (`sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`) and corresponding private fields.

    This fixes TS2430 errors for consumers using `exactOptionalPropertyTypes: true` without `skipLibCheck`, where optional properties with function types need explicit `| undefined` to match their emitted declarations.

- [#1898](https://github.com/modelcontextprotocol/typescript-sdk/pull/1898) [`2a7611d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/2a7611d46b0d4f4e7bd4147c7a3ad3da00e57e52) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add top-level `types`
  field (and `typesVersions` on client/server for their subpath exports) so consumers on legacy `moduleResolution: "node"` can resolve type declarations. The `exports` map remains the source of truth for `nodenext`/`bundler` resolution. The `typesVersions` map includes entries
  for subpaths added by sibling PRs in this series (`zod-schemas`, `stdio`); those entries are no-ops until the corresponding `dist/*.d.mts` files exist.

- [#1901](https://github.com/modelcontextprotocol/typescript-sdk/pull/1901) [`e15a8ef`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e15a8ef3be19520d8159ae9f5b464ba3ac80a5ab) Thanks [@felixweinberger](https://github.com/felixweinberger)! -
  `registerTool`/`registerPrompt` accept a raw Zod shape (`{ field: z.string() }`) for `inputSchema`/`outputSchema`/`argsSchema` in addition to a wrapped Standard Schema. Raw shapes are auto-wrapped with `z.object()`. The raw-shape overloads are `@deprecated`; prefer wrapping
  with `z.object()`.

    Also widens the `completable()` constraint from `StandardSchemaWithJSON` to `StandardSchemaV1` so v1's `completable(z.string(), fn)` continues to work.

- [#2268](https://github.com/modelcontextprotocol/typescript-sdk/pull/2268) [`49c0a71`](https://github.com/modelcontextprotocol/typescript-sdk/commit/49c0a711c8bf2d385f9e03b4f28ba0ff0d0db0bd) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Mark the roots, sampling, and
  logging runtime APIs as `@deprecated` per SEP-2577 (deprecated as of protocol version 2026-07-28; functional for at least twelve months). Annotates `Server.createMessage`/`listRoots`/`sendLoggingMessage`, `McpServer.sendLoggingMessage`,
  `Client.setLoggingLevel`/`sendRootsListChanged`, the `ServerContext.mcpReq.log`/`requestSampling` helpers, and the `roots`/`sampling`/`logging` capability schema fields. JSDoc/docs only — no behavior change.

- [#2275](https://github.com/modelcontextprotocol/typescript-sdk/pull/2275) [`1b53a41`](https://github.com/modelcontextprotocol/typescript-sdk/commit/1b53a415ea2c33aa11ac413fc9c2d68ccffde784) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Add a configurable
  `maxBufferSize` (default 10 MB) to the stdio transports. When a single message would push the read buffer past the limit, the transport now emits an `onerror` and closes instead of growing the buffer unbounded. Configure via `new StdioClientTransport({ ..., maxBufferSize })` or
  `new StdioServerTransport(stdin, stdout, { maxBufferSize })`. The default is exported from `@modelcontextprotocol/client` / `@modelcontextprotocol/server` as `STDIO_DEFAULT_MAX_BUFFER_SIZE`.

- [#2088](https://github.com/modelcontextprotocol/typescript-sdk/pull/2088) [`16d13ab`](https://github.com/modelcontextprotocol/typescript-sdk/commit/16d13abf78b5dba5de73dfa284325b13d4219bb2) Thanks [@mattzcarey](https://github.com/mattzcarey)! - Bundle automatic JSON Schema
  validator defaults in `@modelcontextprotocol/client` and `@modelcontextprotocol/server` runtime shims.

    Client and server pick the right validator automatically based on the runtime: the Node shim uses AJV, the browser/workerd shim uses `@cfworker/json-schema`. Both backends are bundled into the shim chunks that select them, so the default code path needs no extra installs —
    `import { McpServer } from '@modelcontextprotocol/server'` does not pull `ajv` or `@cfworker/json-schema` into the root entry chunk.

    The named validator classes remain part of the public surface for consumers who want to customize the built-in backend (pre-register schemas by `$id`, register custom AJV formats, switch dialects, change `@cfworker/json-schema` draft). They are exposed through explicit
    subpaths so they do not bloat the root index chunk:
    - `import { AjvJsonSchemaValidator } from '@modelcontextprotocol/{client,server}/validators/ajv'`
    - `import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/{client,server}/validators/cf-worker'`

    Importing from one of these subpaths means the corresponding peer dep (`ajv` + `ajv-formats`, or `@cfworker/json-schema`) must be in your `package.json`. The shim keeps its own vendored copy for the default path, so a project can use the subpath in some files and rely on the
    default in others.

    The `jsonSchemaValidator` interface remains the public extension point for replacing validation entirely with a custom implementation.

- [#1976](https://github.com/modelcontextprotocol/typescript-sdk/pull/1976) [`55b1f06`](https://github.com/modelcontextprotocol/typescript-sdk/commit/55b1f06cd4569e334f3435b7971f0446f1ef9be9) Thanks [@felixweinberger](https://github.com/felixweinberger)! - refactor: subclasses
  override `_wrapHandler` hook instead of redeclaring `setRequestHandler`.

- [#1895](https://github.com/modelcontextprotocol/typescript-sdk/pull/1895) [`b256546`](https://github.com/modelcontextprotocol/typescript-sdk/commit/b256546750277faeb7c886792aae5ed26e6904d5) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Fix runtime crash on
  `tools/list` when a tool's `inputSchema` comes from zod 4.0–4.1. The SDK requires `~standard.jsonSchema` (StandardJSONSchemaV1, added in zod 4.2.0); previously a missing `jsonSchema` crashed at `undefined[io]`. `standardSchemaToJsonSchema` now detects zod 4 schemas lacking
  `jsonSchema` and falls back to the SDK-bundled `z.toJSONSchema()`, emitting a one-time console warning. zod 3 schemas (which the bundled zod 4 converter cannot introspect) and non-zod schema libraries without `jsonSchema` get a clear error pointing to `fromJsonSchema()`. The
  workspace zod catalog is also bumped to `^4.2.0`.

## 2.0.0-alpha.2

### Patch Changes

- [#1840](https://github.com/modelcontextprotocol/typescript-sdk/pull/1840) [`424cbae`](https://github.com/modelcontextprotocol/typescript-sdk/commit/424cbaeee13b7fe18d38048295135395b9ad81bb) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - tsdown exports resolution
  fix

## 2.0.0-alpha.1

### Major Changes

- [#1389](https://github.com/modelcontextprotocol/typescript-sdk/pull/1389) [`108f2f3`](https://github.com/modelcontextprotocol/typescript-sdk/commit/108f2f3ab6a1267587c7c4f900b6eca3cc2dae51) Thanks [@DePasqualeOrg](https://github.com/DePasqualeOrg)! - Fix error handling for
  unknown tools and resources per MCP spec.

    **Tools:** Unknown or disabled tool calls now return JSON-RPC protocol errors with code `-32602` (InvalidParams) instead of `CallToolResult` with `isError: true`. Callers who checked `result.isError` for unknown tools should catch rejected promises instead.

    **Resources:** Unknown resource reads now return error code `-32002` (ResourceNotFound) instead of `-32602` (InvalidParams).

    Added `ProtocolErrorCode.ResourceNotFound`.

### Minor Changes

- [#1673](https://github.com/modelcontextprotocol/typescript-sdk/pull/1673) [`462c3fc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/462c3fc47dffac908d2ba27784d47ff010fa065e) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - refactor: extract task
  orchestration from Protocol into TaskManager

    **Breaking changes:**
    - `taskStore`, `taskMessageQueue`, `defaultTaskPollInterval`, and `maxTaskQueueSize` moved from `ProtocolOptions` to `capabilities.tasks` on `ClientOptions`/`ServerOptions`

- [#1689](https://github.com/modelcontextprotocol/typescript-sdk/pull/1689) [`0784be1`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0784be1a67fb3cc2aba0182d88151264f4ea73c8) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Support Standard Schema
  for tool and prompt schemas

    Tool and prompt registration now accepts any schema library that implements the [Standard Schema spec](https://standardschema.dev/): Zod v4, Valibot, ArkType, and others. `RegisteredTool.inputSchema`, `RegisteredTool.outputSchema`, and `RegisteredPrompt.argsSchema` now use
    `StandardSchemaWithJSON` (requires both `~standard.validate` and `~standard.jsonSchema`) instead of the Zod-specific `AnySchema` type.

    **Zod v4 schemas continue to work unchanged** — Zod v4 implements the required interfaces natively.

    ```typescript
    import { type } from 'arktype';

    server.registerTool(
        'greet',
        {
            inputSchema: type({ name: 'string' })
        },
        async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] })
    );
    ```

    For raw JSON Schema (e.g. TypeBox output), use the new `fromJsonSchema` adapter:

    ```typescript
    import { fromJsonSchema } from '@modelcontextprotocol/server';
    import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';

    server.registerTool(
        'greet',
        {
            inputSchema: fromJsonSchema({ type: 'object', properties: { name: { type: 'string' } } }, new AjvJsonSchemaValidator())
        },
        handler
    );
    ```

    **Breaking changes:**
    - `experimental.tasks.getTaskResult()` no longer accepts a `resultSchema` parameter. Returns `GetTaskPayloadResult` (a loose `Result`); cast to the expected type at the call site.
    - Removed unused exports from `@modelcontextprotocol/core-internal`: `SchemaInput`, `schemaToJson`, `parseSchemaAsync`, `getSchemaShape`, `getSchemaDescription`, `isOptionalSchema`, `unwrapOptionalSchema`. Use the new `standardSchemaToJsonSchema` and `validateStandardSchema`
      instead.
    - `completable()` remains Zod-specific (it relies on Zod's `.shape` introspection).

### Patch Changes

- [#1758](https://github.com/modelcontextprotocol/typescript-sdk/pull/1758) [`e86b183`](https://github.com/modelcontextprotocol/typescript-sdk/commit/e86b1835ccf213c3799ac19f4111d01816912333) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - tasks - disallow requesting
  a null TTL

- [#1363](https://github.com/modelcontextprotocol/typescript-sdk/pull/1363) [`0a75810`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0a75810b26e24bae6b9cfb41e12ac770aeaa1da4) Thanks [@DevJanderson](https://github.com/DevJanderson)! - Fix ReDoS vulnerability in
  UriTemplate regex patterns (CVE-2026-0621)

- [#1372](https://github.com/modelcontextprotocol/typescript-sdk/pull/1372) [`3466a9e`](https://github.com/modelcontextprotocol/typescript-sdk/commit/3466a9e0e5d392824156d9b290863ae08192d87e) Thanks [@mattzcarey](https://github.com/mattzcarey)! - missing change for fix(client):
  replace body.cancel() with text() to prevent hanging

- [#1824](https://github.com/modelcontextprotocol/typescript-sdk/pull/1824) [`fcde488`](https://github.com/modelcontextprotocol/typescript-sdk/commit/fcde4882276cb0a7d199e47f00120fe13f7f5d47) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Drop `zod` from
  `peerDependencies` (kept as direct dependency)

    Since Standard Schema support landed, `zod` is purely an internal runtime dependency used for protocol message parsing. User-facing schemas (`registerTool`, `registerPrompt`) accept any Standard Schema library. `zod` remains in `dependencies` and auto-installs; users no
    longer need to install it alongside the SDK.

- [#1761](https://github.com/modelcontextprotocol/typescript-sdk/pull/1761) [`01954e6`](https://github.com/modelcontextprotocol/typescript-sdk/commit/01954e621afe525cc3c1bbe8d781e44734cf81c2) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Convert remaining
  capability-assertion throws to `SdkError(SdkErrorCode.CapabilityNotSupported, ...)`. Follow-up to #1454 which missed `Client.assertCapability()`, the task capability helpers in `experimental/tasks/helpers.ts`, and the sampling/elicitation capability checks in
  `experimental/tasks/server.ts`.

- [#1433](https://github.com/modelcontextprotocol/typescript-sdk/pull/1433) [`78bae74`](https://github.com/modelcontextprotocol/typescript-sdk/commit/78bae7426d4ca38216c0571b5aa7806f58ab81e4) Thanks [@codewithkenzo](https://github.com/codewithkenzo)! - Fix transport errors being
  silently swallowed by adding missing `onerror` callback invocations before all `createJsonErrorResponse` calls in `WebStandardStreamableHTTPServerTransport`. This ensures errors like parse failures, invalid headers, and session validation errors are properly reported via the
  `onerror` callback.

- [#1660](https://github.com/modelcontextprotocol/typescript-sdk/pull/1660) [`689148d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/689148dc7235f53244869ed64b2ecc9ec4ef70f1) Thanks [@rechedev9](https://github.com/rechedev9)! - fix(server): propagate negotiated
  protocol version to transport in \_oninitialize

- [#1568](https://github.com/modelcontextprotocol/typescript-sdk/pull/1568) [`f1ade75`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f1ade75b67a2b46b06316fa4e5caa1d277537cc7) Thanks [@stakeswky](https://github.com/stakeswky)! - Handle stdout errors (e.g. EPIPE)
  in `StdioServerTransport` gracefully instead of crashing. When the client disconnects abruptly, the transport now catches the stdout error, surfaces it via `onerror`, and closes.

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - remove deprecated .tool,
  .prompt, .resource method signatures

- [#1388](https://github.com/modelcontextprotocol/typescript-sdk/pull/1388) [`f66a55b`](https://github.com/modelcontextprotocol/typescript-sdk/commit/f66a55b5f4eb7ce0f8b3885633bf9a7b1080e0b5) Thanks [@mattzcarey](https://github.com/mattzcarey)! - reverting application/json in
  notifications

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - remove npm references, use pnpm

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - clean up package manager usage, all
  pnpm

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - deprecated .tool, .prompt,
  .resource method removal

- [#1279](https://github.com/modelcontextprotocol/typescript-sdk/pull/1279) [`71ae3ac`](https://github.com/modelcontextprotocol/typescript-sdk/commit/71ae3acee0203a1023817e3bffcd172d0966d2ac) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Initial 2.0.0-alpha.0
  client and server package
