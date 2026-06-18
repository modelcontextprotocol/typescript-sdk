# MCP TypeScript SDK examples

One **story** per directory. Every story is a runnable, self-verifying client/server pair: `server.ts` is what you would deploy, `client.ts` is what a host would write — it connects, exercises the feature with the public client API, asserts results, and exits 0. CI runs every
pair over every transport it supports (`scripts/run-examples.ts`); a non-zero exit fails the build.

Run any pair from the repo root:

```bash
# stdio (the client spawns the server itself):
pnpm tsx examples/<story>/client.ts

# Streamable HTTP (two terminals):
pnpm tsx examples/<story>/server.ts --http --port 3000
pnpm tsx examples/<story>/client.ts --http http://127.0.0.1:3000/
```

## Start here

| Story                                 | What it teaches                                                          |
| ------------------------------------- | ------------------------------------------------------------------------ |
| [`tools/`](./tools/README.md)         | Register tools, infer input/output schemas, call them, structured output |
| [`prompts/`](./prompts/README.md)     | Prompts + argument completion                                            |
| [`resources/`](./resources/README.md) | Static + templated resources, list/read                                  |
| [`dual-era/`](./dual-era/README.md)   | One factory, both protocol eras, both transports                         |

## Feature stories

| Story                                                 | What it teaches                                                                                         | Transports   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------ |
| [`mrtr/`](./mrtr/README.md)                           | Multi-round-trip write-once tool, secure `requestState`                                                 | stdio + http |
| [`subscriptions/`](./subscriptions/README.md)         | `subscriptions/listen`: `client.listen()` + auto-open, `handler.notify` / `ServerEventBus`              | stdio + http |
| [`streaming/`](./streaming/README.md)                 | In-flight progress, logging, cancellation                                                               | stdio + http |
| [`elicitation-form/`](./elicitation-form/README.md)   | Form-mode elicitation (server requests user input)                                                      | stdio        |
| [`sampling/`](./sampling/README.md)                   | Tool that requests LLM sampling from the client                                                         | stdio        |
| [`stickynotes/`](./stickynotes/README.md)             | "Real app" capstone: tools mutate state, a resource per note, listChanged, elicitation-confirmed clear  | stdio + http |
| [`caching/`](./caching/README.md)                     | `cacheHints` stamping on cacheable results (2026-07-28)                                                 | stdio + http |
| [`custom-methods/`](./custom-methods/README.md)       | Vendor-prefixed methods + custom notifications                                                          | stdio + http |
| [`schema-validators/`](./schema-validators/README.md) | ArkType, Valibot, Zod, and `outputSchema`                                                               | stdio + http |
| [`custom-version/`](./custom-version/README.md)       | `supportedProtocolVersions` / version negotiation                                                       | stdio + http |
| [`parallel-calls/`](./parallel-calls/README.md)       | Multiple clients / parallel tool calls, per-client notifications                                        | stdio + http |
| [`legacy-routing/`](./legacy-routing/README.md)       | `isLegacyRequest` in front of an existing sessionful 1.x deployment + a strict modern entry on one port | http         |
| [`bearer-auth/`](./bearer-auth/README.md)             | Resource server with bearer token; `401` + `WWW-Authenticate`                                           | http         |

## HTTP hosting variants

| Story                                               | What it teaches                                               | Transports |
| --------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| [`stateless-legacy/`](./stateless-legacy/README.md) | `createMcpHandler` default posture (the minimal deployment)   | http       |
| [`json-response/`](./json-response/README.md)       | `createMcpHandler({ responseMode: 'json' })`                  | http       |
| [`hono/`](./hono/README.md)                         | `createMcpHandler(...).fetch` on Hono / web-standard runtimes | http       |
| [`sse-polling/`](./sse-polling/README.md)           | SEP-1699 SSE polling/resumption (sessionful 2025)             | http       |
| [`standalone-get/`](./standalone-get/README.md)     | Standalone GET stream + `listChanged` push (sessionful 2025)  | http       |

## Excluded

The interactive OAuth set lives under [`oauth/`](./oauth/README.md) and is excluded from the harness (browser flow / no in-repo Authorization Server). The [`guides/`](./guides/README.md) directory holds the snippet collections synced into `docs/server.md` and `docs/client.md` —
typecheck-only, not runnable. `shared/` is the demo OAuth provider library used by the OAuth examples. The `server-quickstart/` and `client-quickstart/` packages are the website-tutorial sources (external network / API key; typecheck-only).
