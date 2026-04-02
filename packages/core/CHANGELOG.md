# @modelcontextprotocol/core

## 2.0.0-alpha.1

### Minor Changes

- [#1673](https://github.com/modelcontextprotocol/typescript-sdk/pull/1673) [`462c3fc`](https://github.com/modelcontextprotocol/typescript-sdk/commit/462c3fc47dffac908d2ba27784d47ff010fa065e) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - refactor: extract task
  orchestration from Protocol into TaskManager

    **Breaking changes:**
    - `taskStore`, `taskMessageQueue`, `defaultTaskPollInterval`, and `maxTaskQueueSize` moved from `ProtocolOptions` to `capabilities.tasks` on `ClientOptions`/`ServerOptions`

- [#1389](https://github.com/modelcontextprotocol/typescript-sdk/pull/1389) [`108f2f3`](https://github.com/modelcontextprotocol/typescript-sdk/commit/108f2f3ab6a1267587c7c4f900b6eca3cc2dae51) Thanks [@DePasqualeOrg](https://github.com/DePasqualeOrg)! - Fix error handling for
  unknown tools and resources per MCP spec.

    **Tools:** Unknown or disabled tool calls now return JSON-RPC protocol errors with code `-32602` (InvalidParams) instead of `CallToolResult` with `isError: true`. Callers who checked `result.isError` for unknown tools should catch rejected promises instead.

    **Resources:** Unknown resource reads now return error code `-32002` (ResourceNotFound) instead of `-32602` (InvalidParams).

    Added `ProtocolErrorCode.ResourceNotFound`.

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

- [#1735](https://github.com/modelcontextprotocol/typescript-sdk/pull/1735) [`a2e5037`](https://github.com/modelcontextprotocol/typescript-sdk/commit/a2e503733f6f3eea3a79a80bdc1b3cdd743f8bb3) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Abort in-flight request
  handlers when the connection closes. Previously, request handlers would continue running after the transport disconnected, wasting resources and preventing proper cleanup. Also fixes `InMemoryTransport.close()` firing `onclose` twice on the initiating side.

- [#1574](https://github.com/modelcontextprotocol/typescript-sdk/pull/1574) [`379392d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/379392d04460ee2cbeecae374901fae21e525031) Thanks [@olaservo](https://github.com/olaservo)! - Add missing `size` field to
  `ResourceSchema` to match the MCP specification

- [#1363](https://github.com/modelcontextprotocol/typescript-sdk/pull/1363) [`0a75810`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0a75810b26e24bae6b9cfb41e12ac770aeaa1da4) Thanks [@DevJanderson](https://github.com/DevJanderson)! - Fix ReDoS vulnerability in
  UriTemplate regex patterns (CVE-2026-0621)

- [#1761](https://github.com/modelcontextprotocol/typescript-sdk/pull/1761) [`01954e6`](https://github.com/modelcontextprotocol/typescript-sdk/commit/01954e621afe525cc3c1bbe8d781e44734cf81c2) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Convert remaining
  capability-assertion throws to `SdkError(SdkErrorCode.CapabilityNotSupported, ...)`. Follow-up to #1454 which missed `Client.assertCapability()`, the task capability helpers in `experimental/tasks/helpers.ts`, and the sampling/elicitation capability checks in
  `experimental/tasks/server.ts`.

- [#1790](https://github.com/modelcontextprotocol/typescript-sdk/pull/1790) [`89fb094`](https://github.com/modelcontextprotocol/typescript-sdk/commit/89fb0947b487b37f9bfcc2a2486dcd33d3922f8e) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Consolidate per-request
  cleanup in `_requestWithSchema` into a single `.finally()` block. This fixes an abort signal listener leak (listeners accumulated when a caller reused one `AbortSignal` across requests) and two cases where `_responseHandlers` entries leaked on send-failure paths.

- [#1486](https://github.com/modelcontextprotocol/typescript-sdk/pull/1486) [`65bbcea`](https://github.com/modelcontextprotocol/typescript-sdk/commit/65bbceab773277f056a9d3e385e7e7d8cef54f9b) Thanks [@localden](https://github.com/localden)! - Fix InMemoryTaskStore to enforce
  session isolation. Previously, sessionId was accepted but ignored on all TaskStore methods, allowing any session to enumerate, read, and mutate tasks created by other sessions. The store now persists sessionId at creation time and enforces ownership on all reads and writes.

- [#1766](https://github.com/modelcontextprotocol/typescript-sdk/pull/1766) [`48aba0d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/48aba0d3c3b2ee04c442934095b663d19e07a3b3) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Add explicit
  `| undefined` to optional properties on the `Transport` interface and `TransportSendOptions` (`onclose`, `onerror`, `onmessage`, `sessionId`, `setProtocolVersion`, `setSupportedProtocolVersions`, `onresumptiontoken`).

    This fixes TS2420 errors for consumers using `exactOptionalPropertyTypes: true` without `skipLibCheck`, where the emitted `.d.ts` for implementing classes included `| undefined` but the interface did not.

    Workaround for older SDK versions: enable `skipLibCheck: true` in your tsconfig.

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - remove deprecated .tool,
  .prompt, .resource method signatures

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - remove npm references, use pnpm

- [#1534](https://github.com/modelcontextprotocol/typescript-sdk/pull/1534) [`69a0626`](https://github.com/modelcontextprotocol/typescript-sdk/commit/69a062693f61e024d7a366db0c3e3ba74ff59d8e) Thanks [@josefaidt](https://github.com/josefaidt)! - clean up package manager usage, all
  pnpm

- [#1796](https://github.com/modelcontextprotocol/typescript-sdk/pull/1796) [`d6a02c8`](https://github.com/modelcontextprotocol/typescript-sdk/commit/d6a02c85c0514658c27615398a3003aadce80fb0) Thanks [@felixweinberger](https://github.com/felixweinberger)! - Ensure
  `standardSchemaToJsonSchema` emits `type: "object"` at the root, fixing discriminated-union tool/prompt schemas that previously produced `{oneOf: [...]}` without the MCP-required top-level type. Also throws a clear error when given an explicitly non-object schema (e.g.
  `z.string()`). Fixes #1643.

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - deprecated .tool, .prompt,
  .resource method removal

- [#1762](https://github.com/modelcontextprotocol/typescript-sdk/pull/1762) [`64897f7`](https://github.com/modelcontextprotocol/typescript-sdk/commit/64897f78ce78f736b027dfecd1b4326c8c6678c7) Thanks [@felixweinberger](https://github.com/felixweinberger)! -
  `ReadBuffer.readMessage()` now silently skips non-JSON lines instead of throwing `SyntaxError`. This prevents noisy `onerror` callbacks when hot-reload tools (tsx, nodemon) write debug output like "Gracefully restarting..." to stdout. Lines that parse as JSON but fail JSONRPC
  schema validation still throw.
