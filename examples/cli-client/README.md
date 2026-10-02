# cli-client — the reference MCP host

An interactive, LLM-connected chat CLI with **no built-in tools**: everything the model can do comes from the MCP servers you connect it to. It is a minimal but complete host — every client-side MCP feature is wired the way a host application should wire it — built to be read and copied from.

Its standard workload is [`examples/todos-server`](../todos-server/README.md), the reference server, but it connects to **any** MCP server: a URL, a command line, or an `mcpServers`-style config file.

## Quick start (no API key)

From the repo root (first time: `pnpm install && pnpm build:all`):

```bash
pnpm --filter @mcp-examples/cli-client start
```

That spawns todos-server over stdio and answers with the keyless `scripted` provider — enough to see the wiring move. For a real conversation, add a provider key (next section), then say `hi`: the model offers a guided tour that walks through every feature.

## Providers

The model sits behind one small interface (`providers/provider.ts`); each file in `providers/` is a complete, copyable mapping for one vendor. Pick one explicitly with `--provider`, or let the CLI auto-pick from the environment (checked in this order):

| Provider    | Enable with                                                    | Default model                               | Pin a model                         |
| ----------- | -------------------------------------------------------------- | ------------------------------------------- | ----------------------------------- |
| `anthropic` | `ANTHROPIC_API_KEY` (or an OAuth-style `ANTHROPIC_AUTH_TOKEN`) | newest Sonnet, resolved from the models API | `--model <id>` or `ANTHROPIC_MODEL` |
| `openai`    | `OPENAI_API_KEY`                                               | newest mainline GPT (non-pro)               | `--model <id>` or `OPENAI_MODEL`    |
| `gemini`    | `GEMINI_API_KEY`                                               | newest stable Flash                         | `--model <id>` or `GEMINI_MODEL`    |
| `scripted`  | nothing — the keyless default                                  | n/a (replays canned turns)                  | n/a                                 |

```bash
ANTHROPIC_API_KEY=sk-… pnpm --filter @mcp-examples/cli-client start -- --provider anthropic
OPENAI_API_KEY=sk-…    pnpm --filter @mcp-examples/cli-client start -- --provider openai
GEMINI_API_KEY=…       pnpm --filter @mcp-examples/cli-client start -- --provider gemini

# pin an exact model instead of the resolved latest
ANTHROPIC_API_KEY=sk-… pnpm --filter @mcp-examples/cli-client start -- --provider anthropic --model claude-sonnet-4-5
```

Model ids are deliberately not hardcoded: unless pinned, each provider asks its own models API for the newest mid-tier model, so the example keeps working as vendors ship new ones. The `scripted` provider replays a fixed conversation — it is what CI uses (see [testing](#how-this-example-is-tested)), and what you get when no key is set.

## Pair it with todos-server (two terminals)

The full demo is the reference pair talking over HTTP:

```bash
# Terminal A — serve the reference server over Streamable HTTP (port 3000)
pnpm --filter @mcp-examples/todos-server start:http

# Terminal B — connect the host to it (add a provider key for a real model)
ANTHROPIC_API_KEY=sk-… pnpm --filter @mcp-examples/cli-client start -- --server http://127.0.0.1:3000/mcp --provider anthropic
```

The status line shows what was negotiated — `connected to "todos" (2026-07-28, 8 tools, 2 resources, 2 prompts)`. Add `--legacy` in terminal B to force the 2025-era handshake against the same server and watch the legacy arms of every feature run instead (`connected to "todos" (2025-11-25, …)`). To hold the connection to one exact revision, use `--protocol-version 2025-06-18` (or any supported revision) — the connection fails rather than settle on anything else.

A tour that touches everything, in one sitting:

```text
brainstorm some tasks               ← elicitation form (theme + how many) + approval-gated sampling
prioritize my open tasks            ← sampling: you approve the request before it runs
/todos:plan-my-day focus=ops        ← an MCP prompt as a slash command (tab-completes)
@todos:todos://board what's next?   ← attach a resource as context
/watch @todos:todos://board         ← subscribe: a note appears whenever the board changes
do all my tasks                     ← per-task progress + log notifications stream live
(Ctrl-C mid-run)                    ← cancellation: the tool stops early, the model is told
clear my completed tasks            ← elicitation-confirmed bulk delete
/help  /servers  /tools  /resources  /prompts  /roots
```

Tab completes slash commands, prompt names, `@server:uri` mentions, and prompt argument values (the latter through MCP `completion/complete`).

## Every feature, and where to see it

| MCP feature        | Where you see it                                  | What the host does                                                                                                                                                     |
| ------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools              | just chat                                         | aggregates every server's tools under `mcp__<server>__<tool>`, hands them to the model, executes the calls it makes, feeds results (including `isError`) back, repeats |
| Resources          | `@todos:todos://board` in a message, `/resources` | `resources/read` → injected as a provenance-labelled context block; `list_changed` keeps the cached list fresh                                                         |
| Subscriptions      | `/watch @todos:todos://board`                     | `resources/subscribe` on 2025-era connections, a `subscriptions/listen` resource filter on 2026-07-28; updates render as notes as the board changes                    |
| Prompts            | `/todos:plan-my-day focus=ops`, `/prompts`        | `prompts/get` seeds the conversation with the returned messages, keeping their roles                                                                                   |
| Completions        | tab on prompt arguments                           | `completion/complete` against the server's `completable()` argument values                                                                                             |
| Sampling           | the `prioritize` / `brainstorm_tasks` tools       | the server borrows the host's model: the request is shown to you for approval, then routed through the same `LLMProvider` that drives the chat                         |
| Elicitation        | `clear_done`, `brainstorm_tasks`                  | a terminal form generated from the requested schema; accept / decline / cancel are all honoured                                                                        |
| Roots              | `--root`, `/roots`, `/root add <path>`            | workspace roots served via `roots/list`; on change, `roots/list_changed` on 2025-era connections (2026-07-28 removed the notification — servers re-request roots)      |
| Logging & progress | the status lines, "do all my tasks"               | `notifications/message` and per-call progress rendered as the work happens                                                                                             |
| Cancellation       | Ctrl-C while a tool call is running               | the host aborts the call's `RequestOptions.signal` (the SDK sends `notifications/cancelled`); todos-server checks `ctx.mcpReq.signal` and stops early                  |
| Auth               | HTTP servers in your config                       | static headers from the config, or a full browser OAuth flow when a server answers 401                                                                                 |

## Connect it to your own servers

For a one-off connection, skip the config file and pass the server directly:

```sh
pnpm --filter @mcp-examples/cli-client start -- --server https://your-server.example.com/mcp
```

`--server` (repeatable) connects to exactly the targets you list: http(s) URLs over Streamable HTTP — the OAuth flow starts automatically if the server answers 401 — and anything else is spawned as a stdio command line.

For a persistent setup, copy `config.example.json` to `config.json` (or pass `--config <path>`) and list any MCP servers — the same shape most hosts read:

```jsonc
{
    "mcpServers": {
        "todos": { "command": "npx", "args": ["-y", "tsx", "/absolute/path/to/examples/todos-server/server.ts"] },
        "docs": { "url": "https://example.com/mcp" },
        "internal": { "url": "https://mcp.internal.example.com/mcp", "headers": { "Authorization": "Bearer ${INTERNAL_TOKEN}" } }
    }
}
```

- `command`/`args` entries are spawned as child processes (stdio). They get a minimal environment plus whatever the entry's `env` lists — never the host's full environment. Relative paths resolve from wherever you run the CLI, so prefer absolute paths when in doubt.
- `url` entries connect over Streamable HTTP. `${VAR}` in `headers`/`env` values is read from the host's environment, so secrets stay out of the file.
- An HTTP server without configured headers that answers 401 triggers the OAuth flow: cli-client asks before opening your browser, runs authorization-code + PKCE against the server's authorization server, and verifies the callback `state`. Tokens live in memory for the session. (Try it against the [`oauth/`](../oauth/README.md) example server; `--callback-port <n>` pins the loopback callback port when you need to forward it over SSH.)

## All flags

```text
--server <target>       connect to just this server: an http(s) URL (OAuth on demand) or a stdio command line (repeatable)
--config <path>         mcpServers config file (default: ./config.json, falling back to spawning todos-server)
--provider <name>       scripted | anthropic | openai | gemini (default: first one with a key in the env, else scripted)
--model <id>            pin a model id (default: the provider's latest mid-tier model)
--root <path>           workspace root exposed to servers via roots/list (repeatable; default: cwd)
--callback-port <n>     fixed loopback port for the OAuth callback (default: a free port)
--legacy                use the 2025 initialize handshake instead of probing for 2026-07-28
--protocol-version <v>  negotiate exactly this revision: 2025-era values (e.g. 2025-06-18) via the legacy handshake, 2026-07-28+ via a modern pin
-h, --help              show usage
```

## How this example is tested

`client.ts` is the CI entry: it replays a scripted conversation (`script/session.ts`) against todos-server with the `ScriptedProvider`, asserting at each step that the loop, namespacing, resource attachment, prompt-role handling, sampling approval, the multi-round elicitation + signed-`requestState` flow, completions, cancellation, progress, and logging actually round-tripped — over stdio and Streamable HTTP, on both protocol eras (the progress/logging/subscription assertions run on the stdio legs, where delivery timing is deterministic). `pnpm run:examples` runs it in CI; `pnpm --filter @mcp-examples/cli-client test` runs the unit tests for the provider mappings, routing, config parsing, form handling, and the OAuth helpers.

On the legacy-era HTTP leg the sampling/elicitation steps are skipped: push-style server→client requests need a session, and todos-server runs `createMcpHandler`'s default stateless posture there (see [`sampling/`](../sampling/README.md) for the same caveat).

## Layout

```text
cli.ts          interactive entry (readline chat)
client.ts       CI entry (scripted conversation, self-verifying)
server.ts       thin shim that runs ../todos-server/server.ts (so the example runner can spawn the pair)
host/           the host itself: connections, tool routing, resources, prompts,
                sampling/elicitation/roots handlers, OAuth, config, terminal UI
providers/      the LLMProvider seam + one complete mapping per provider
script/         the scripted conversation CI replays
test/           unit tests
```

Unlike the single-feature stories, the SDK `Client`/transport construction here lives in `host/host.ts` rather than inline in the entry files — the host wiring is what this example documents.

## Design notes

Choices in here that are worth understanding before copying:

- **The provider seam is deliberately example-local.** The SDK stays a protocol library; a host's message shapes belong to the host. The seam earns its keep twice: MCP `Tool.inputSchema` is already JSON Schema and passes to each vendor API untouched, and the same `generate()` answers both the chat loop and servers' sampling requests — one model integration, two consumers.
- **Tool results go back to the model verbatim, including failures.** An `isError` result is fed back as a tool message rather than thrown, so the model can read the error and try something else. A round cap bounds a model that keeps calling tools forever.
- **Server-controlled text is untrusted display input.** ANSI/control escapes are stripped on every render path; attached resources are size-capped and wrapped in provenance labels so the model knows what it is reading and where it came from, and is told not to re-fetch it.
- **Prompts keep their roles.** `prompts/get` messages seed the conversation as separate user/assistant turns instead of being flattened into one block — that is what the shape is for.
- **Approvals are explicit and fail closed.** Sampling shows the full request (not a preview) and caps `maxTokens` regardless of what the server asked. Browser-opening — OAuth and URL-mode elicitation alike — requires `https:` (or loopback) and user consent. The OAuth callback's `state` is verified by the host, and a missing or mismatched value aborts the flow.
- **Tool execution is not gated here** because an interactive user watches every call and holds Ctrl-C. An unattended host must add a consent policy — confirm destructive or side-effecting calls, or keep a per-server allowlist — and should treat tool annotations (`readOnlyHint`, `destructiveHint`) as UX hints, never as a security boundary.
- **Spawned servers get a minimal environment**: the config entry's `env` plus defaults, never the host's full environment, so provider API keys cannot leak into child processes.

Not goals of this example: it is not an agent framework (no plugins, sub-agents, or planning), there is no streaming output, no conversation persistence, and the providers make exactly one `generate()` call per turn.
