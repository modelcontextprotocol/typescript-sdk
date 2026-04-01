# @modelcontextprotocol/server

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
    import { fromJsonSchema, AjvJsonSchemaValidator } from '@modelcontextprotocol/core';

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
    - Removed unused exports from `@modelcontextprotocol/core`: `SchemaInput`, `schemaToJson`, `parseSchemaAsync`, `getSchemaShape`, `getSchemaDescription`, `isOptionalSchema`, `unwrapOptionalSchema`. Use the new `standardSchemaToJsonSchema` and `validateStandardSchema` instead.
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
