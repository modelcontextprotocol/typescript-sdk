---
title: Building a Host
---

# Building a host

A _host_ is the application that sits between users, a language model, and MCP servers: Claude, an IDE, a chat product, an internal tool with its own UI, a custom agent runtime. The SDK gives you the protocol verbs (`listTools`, `callTool`, `readResource`, …); this guide covers the part the protocol deliberately leaves to you — the application behaviors that turn those verbs into something a user can feel: tools the model actually calls, resources that become context, prompts that become commands, sampling and elicitation that round-trip through your UI.

Everything here is narrated against [`examples/cli-client`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/cli-client) — a minimal but complete host you can run, read, and copy from. For the protocol-level concepts behind each feature, see the spec site's [client concepts](https://modelcontextprotocol.io/docs/learn/client-concepts) and [architecture](https://modelcontextprotocol.io/docs/learn/architecture) pages; this guide does not restate them.

## Do you actually need to build a host?

Most applications should not hand-roll this layer. Pick the first row that matches and stop there:

| You are…                                                                                                               | Do this instead                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Building an MCP **server**                                                                                             | Start at the [server quickstart](./server-quickstart.md) — you never write a host.               |
| Bringing tools into **an existing host** (Claude, ChatGPT, Cursor, an IDE)                                             | Configure your server in that host; read its docs. Nothing to build.                             |
| Calling a model API that offers a **hosted MCP connector**                                                             | Use the provider's connector and pass it your server's URL — the provider runs the loop for you. |
| Building on an **agent framework** that already speaks MCP (Claude Agent SDK, Vercel AI SDK, Pydantic AI, …)           | Use the framework's MCP support; it owns the loop and the feature wiring.                        |
| Building the application that owns the conversation — an IDE, a chat product, an internal tool, your own agent runtime | You are building a host. Keep reading.                                                           |

The narrow audience of this guide is the one that decides whether anything beyond tools ever gets used: hosts are where resources, prompts, sampling, and elicitation either become product features or stay dead protocol surface.

## The mental model

A host is a conduit between a model and servers it does not trust:

1. Discover what each configured server offers (`tools/list`, `resources/list`, `prompts/list`).
2. Hand the model the tool definitions, namespaced per server.
3. Execute the tool calls the model makes — against the server that owns them — and feed the results back, verbatim and labelled.
4. Surface everything that needs a human (sampling approval, elicitation forms, OAuth) through your UI.

The model never talks to a server directly; your host is the only thing that does. That makes the host responsible for the two judgement calls the protocol cannot make for you: _what the model gets to see_ (context, truncation, provenance) and _what the user gets to approve_ (sampling, destructive actions, credentials).

cli-client's shape, which this guide walks through:

```text
examples/cli-client/                       (paired with examples/todos-server, the reference server)
  cli.ts          interactive entry        host/host.ts    connections, routing, handlers
  client.ts       scripted CI entry        host/loop.ts    the conversation loop
  providers/      the LLM provider seam    host/auth.ts    OAuth for protected servers
                                           host/ui.ts      terminal UI + elicitation forms
```

## The provider seam

The single most useful structural decision in a host is a thin interface between "the conversation" and "whatever model API you use". In cli-client that seam is `LLMProvider`:

```ts source="../examples/cli-client/providers/provider.ts#llmProvider"
export interface ToolDefinition {
    /** Namespaced tool name as exposed to the model (e.g. `mcp__todos__add_task`). */
    name: string;
    description?: string;
    /** JSON Schema for the tool's arguments, passed through from the MCP `Tool.inputSchema`. */
    inputSchema: Record<string, unknown>;
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string };

export interface ToolCall {
    /** Provider-assigned id, echoed back on the matching `role: 'tool'` message. */
    id: string;
    /** Namespaced tool name (matches a `ToolDefinition.name`). */
    name: string;
    arguments: Record<string, unknown>;
}

export type ChatMessage =
    | { role: 'user'; content: ContentPart[] }
    | { role: 'assistant'; content: ContentPart[]; toolCalls?: ToolCall[] }
    | { role: 'tool'; toolCallId: string; toolName: string; content: ContentPart[]; isError?: boolean };

export interface GenerateRequest {
    system?: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    maxTokens?: number;
    temperature?: number;
}

export interface GenerateResult {
    /** Assistant prose (may be empty when the model only calls tools). */
    text: string;
    /** Tool calls the host must execute and feed back as `role: 'tool'` messages. */
    toolCalls: ToolCall[];
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other';
    /** Provider-reported model id (also used to answer MCP sampling requests). */
    model: string;
}

export interface LLMProvider {
    readonly name: string;
    generate(request: GenerateRequest): Promise<GenerateResult>;
}
```

Two things make this seam earn its keep:

- **MCP tool definitions pass through it untouched.** `Tool.inputSchema` is already JSON Schema; every major provider accepts it as-is (`input_schema` for the Anthropic Messages API, `function.parameters` for Chat Completions, `parametersJsonSchema` for Gemini). The per-provider files in [`providers/`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/cli-client/providers) are each a complete, copyable mapping; the differences (where tool results go, how errors are flagged, what ids look like) are exactly the part worth reading once.
- **It serves both directions.** The chat loop calls it to drive the conversation, and the MCP sampling handler calls it to answer servers — one model integration, two consumers.

Keep the seam in your application. It is deliberately _not_ an SDK package: the SDK stays a protocol library, and your host's message shapes belong to your host.

## The loop (tools)

Nothing in MCP runs the conversation for you. The loop every host writes:

```ts source="../examples/cli-client/host/loop.ts#theLoop"
export async function runModelRounds(session: ChatSession): Promise<void> {
    const { host, provider, ui } = session;
    // Server instructions and the aggregated tool list are stable within a single user turn.
    const system = buildSystemPrompt(host);
    const tools = host.toolDefinitions();
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const stopSpinner = ui.spinner();
        let result: GenerateResult;
        try {
            result = await provider.generate({
                system,
                messages: session.messages,
                tools,
                maxTokens: session.maxTokens
            });
        } finally {
            stopSpinner();
        }
        session.messages.push({
            role: 'assistant',
            content: result.text ? [textPart(result.text)] : [],
            ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {})
        });
        if (result.model !== session.announcedModel) {
            session.announcedModel = result.model;
            ui.status(`model: ${result.model}`);
        }
        if (result.text) ui.print(result.text);
        if (result.toolCalls.length === 0) return;

        // cli-client executes tool calls without a confirmation gate because an interactive
        // user watches every `→` line and holds Ctrl-C; a host without that live supervision
        // must gate execution on user consent (see the guide's security section).
        for (const call of result.toolCalls) {
            ui.status(`→ ${call.name} ${JSON.stringify(call.arguments)}`);
            // Long-running calls stay cancellable: Ctrl-C aborts this call (the SDK sends
            // notifications/cancelled) and the failure goes back to the model like any other.
            const cancellation = new AbortController();
            ui.setCancelHandler(() => {
                ui.status(`cancelling ${call.name}…`, 'cancel');
                cancellation.abort();
            });
            let parts: ContentPart[];
            let isError: boolean;
            try {
                ({ parts, isError } = await host.executeToolCall(call, { signal: cancellation.signal }));
            } finally {
                ui.setCancelHandler(undefined);
            }
            const summary = partsToDisplayText(parts);
            ui.status(`${isError ? '✗' : '✓'} ${call.name}: ${summary.length > 200 ? `${summary.slice(0, 200)}…` : summary}`);
            session.messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: parts, isError });
        }
    }
    ui.print('(stopped: tool-call round limit reached)');
}
```

The details that separate a working loop from a frustrating one:

- **Namespace per server.** cli-client exposes every tool as `mcp__<server>__<tool>` (`host/naming.ts`), so two servers can both ship `search` and a model-issued call always routes back to the server that owns it. Sanitize server names first — provider APIs restrict tool-name characters.
- **Handle every tool call in the round, then loop.** Models issue parallel calls; execute them all and send all the results back before asking for the next turn (the Anthropic mapping additionally requires the results to share one user message — see `providers/anthropic.ts`).
- **`isError` is a result, not an exception.** Mark it as an error in the provider's format and let the model read the message — it is allowed to try something else. A _thrown_ error from `callTool` (unknown tool, timeout, lost connection) is different in kind, but the model should see that as a failed call too.
- **Narrow content blocks; never assume text.** Tool results can carry text, images, audio, resource links, and embedded resources (`host/content.ts` shows the full narrowing). Pass images through if your provider mapping supports them; reduce the rest to labelled placeholders.
- **Truncation is your job.** Neither the SDK nor the protocol caps what a server returns. cli-client caps everything it injects at 50k characters; pick a budget and state it.
- **Bound the loop.** A model that keeps calling tools forever is a bug; cap the rounds and say so when you hit the cap.
- **Fold `getInstructions()` into the system prompt** — server instructions exist precisely so the host can pass them to the model.

> **What real hosts do** — Claude Code uses the same `mcp__<server>__<tool>` namespacing and feeds `isError` results back to the model as errors. Almost nobody in the wider ecosystem shows the loop itself: most SDK examples stop at "list tools and print them", and frameworks bury the loop inside middleware. It is one screen of code; write it once, visibly.

## Resources become context

Resources are **application-driven**: the protocol gives you list/read and deliberately does not say when to read. Three patterns cover real hosts:

1. **User-driven (what cli-client implements).** The user names a resource — `@todos:todos://board what should I tackle first?` — the host calls `readResource`, and injects the contents as a context block _with provenance_:

    ```text
    <attached-resource server="todos" uri="todos://board">
    …contents…
    </attached-resource>
    The user attached this MCP resource as context. Use it to answer; do not re-read it unless told it changed.
    ```

    Label where the content came from, cap its size, replace binary contents with a placeholder, and tell the model not to re-fetch. Use `listResources()` (and resource templates plus `complete()`) to power the picker UX, and the client's `listChanged` option to keep the cached list fresh. To watch a specific resource, subscribe to it — `resources/subscribe` on 2025-era connections, `client.listen({ resourceSubscriptions: [uri] })` on 2026-07-28 — and react to `notifications/resources/updated`; cli-client exposes this as `/watch @server:uri`.

2. **Auto-attach policies.** Some hosts attach certain resources to every conversation (an "active document", a project manifest) based on their own rules. Same mechanics as above — the policy is the only new part.

3. **Model-driven (resources as tools).** If you want the _model_ to decide what to read, expose two synthetic tools — `list_resources(server?)` and `read_resource(server, uri)` — that call `listResources`/`readResource` under the hood. Register them only when at least one connected server actually declares the `resources` capability, apply the same size cap, and treat "not found" as a soft error that tells the model to re-list. This is the pattern to reach for when users won't know URIs but the task needs server data.

> **What real hosts do** — Claude Code implements the user-driven path (`@server:uri`) _and_ the model-driven fallback (`ListMcpResources` / `ReadMcpResource` tools, registered only when a server declares resources, with a 100k-character cap), does not implement `resources/subscribe`, and relies on `list_changed` to invalidate its cached list.

## Prompts become commands

Prompts are user-invoked workflows. The host's job is small and concrete:

- Surface each prompt as a command — cli-client uses `/server:prompt-name key=value …` — listing `prompt.arguments` so the user knows what to supply, and prompting for missing required arguments (`complete()` can power autocompletion for argument values).
- Call `getPrompt` and **append the returned messages to the conversation as separate turns, keeping their roles**. A prompt's value is often exactly that it seeds a multi-turn shape (context as a user turn, a primed assistant turn, then the ask); flattening it into one block of text throws that away.
- Then run the loop — the seeded conversation usually ends with something for the model to do.

> **What real hosts do** — Claude Code exposes every server prompt as a slash command, but flattens the returned messages into a single hidden user message, discarding the roles. Keep the roles; it costs nothing and is what the shape is for.

## Sampling: the server borrows your model

`sampling/createMessage` is a server asking the _host's_ model to run a completion — so servers can ship LLM-powered features without shipping API keys. The host decides whether and how:

```ts
client.setRequestHandler('sampling/createMessage', async request => {
    const params = request.params;
    const approved = await ui.confirm(`Server "${name}" wants to run an LLM request (${params.maxTokens} max tokens): "${preview(params)}". Allow?`);
    if (!approved) {
        throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'User declined the sampling request');
    }
    const result = await provider.generate({
        system: params.systemPrompt,
        messages: params.messages.map(toChatMessage),
        maxTokens: Math.min(params.maxTokens, SAMPLING_MAX_TOKENS_CAP)
    });
    return { role: 'assistant', content: { type: 'text', text: result.text }, model: result.model, stopReason: 'endTurn' };
});
```

The three host responsibilities, in order of importance:

1. **Gate it on the user.** A sampling request spends the user's tokens and can carry data to a third-party API. Show what the server asked and require an explicit yes; treat "no answer" as no. Cap `maxTokens` regardless of what was requested.
2. **Route it through the same provider as the chat.** That is the entire point — one model integration serves both the conversation and the servers (todos-server's `prioritize` and `brainstorm_tasks` tools both work this way through cli-client).
3. **Decline by omission, not by error.** If your host will not support sampling, simply do not declare the `sampling` capability — servers can check for it and fall back. Do not declare it and then reject every request.

Declare the capability in the client constructor and register the handler once; the SDK carries the request over both protocol revisions (as a server→client request on 2025-era connections, and via `input_required` results on 2026-07-28 connections) without any era-specific code in your handler. Note that 2025-era push-style sampling needs a sessionful server when running over Streamable HTTP, and that as of the 2026-07-28 revision sampling is in a deprecation window (see the spec's versioning notes) — supported, but check the spec status before making it load-bearing.

> **What real hosts do** — Claude Code does not declare the sampling capability at all (it has its own model loop and declines by omission). The C# SDK and FastMCP both ship "sampling handler backed by your chat client" helpers — evidence that when a host does say yes, wiring it to the existing provider is the established shape.

## Elicitation: the server asks your user

Elicitation is the inverse of sampling: the server needs _the human_, not the model. Two modes arrive at the same handler:

- **Form mode** carries `message` plus a flat `requestedSchema` (strings, numbers, booleans, enums — no nesting). Generate UI from it: cli-client walks the properties and asks one question per field in the terminal (`host/ui.ts`), validating against the declared type before accepting.
- **URL mode** carries a URL the user must visit (payment, OAuth-style consent, anything that should not pass through the host). Apply the same https-or-loopback gate as OAuth before offering it, then show it, let the user open it, confirm when done.

Return exactly one of the three outcomes and mean it: `accept` (with the collected content), `decline` (the user said no), `cancel` (the user dismissed it). Decline and cancel are answers, not retries — a server that re-asks on decline is a bug, and a host that maps errors to `accept` is a worse one. cli-client fails closed: any error in form collection becomes `cancel`.

## Roots

Roots tell servers which directories the conversation is about. Derive them from something real — the workspace folders, a `--root` flag, the cwd — declare the `roots` capability, answer `roots/list`, and send `roots/list_changed` when the set changes (on 2025-era connections; 2026-07-28 servers re-request roots when they need them). cli-client keeps this to a dozen lines in `host/host.ts` plus a `/root add` command; it is the cheapest feature in the protocol to support properly. Like sampling and logging, roots is in the 2026-07-28 deprecation window (SEP-2577) — supported throughout the window, with paths passed as tool parameters or configuration as the long-term direction.

## Logging and progress

- **Progress** is the live channel: pass `onprogress` on long-running `callTool` calls and render it (a status line is enough). It also gives you per-call attribution when the model runs tools in parallel. (todos-server demonstrates it with `work_through_tasks` — say "do all my tasks" and watch the status line.)
- **Cancellation** is the other half of long-running calls: pass an `AbortSignal` in the call's `RequestOptions` and abort it to cancel — the SDK sends `notifications/cancelled`, the local call rejects, and a well-behaved server checks `ctx.mcpReq.signal` and stops working. cli-client wires Ctrl-C during a tool call to exactly this; try it mid-way through "do all my tasks".
- **Logging**: render `notifications/message` as it arrives, tagged with the server name. On 2025-era connections call `setLoggingLevel(...)` once per server to opt in; on 2026-07-28 connections log delivery is opted into per request via the `io.modelcontextprotocol/logLevel` `_meta` key (and MCP-level logging is in a deprecation window). Whatever the era: a stdio server's `stderr` is also worth surfacing — that is where well-behaved servers put their own diagnostics.

## Connecting, configuration, and auth

Hosts conventionally read an `mcpServers`-shaped config (cli-client's `host/config.ts`):

- `{ command, args, env?, cwd? }` entries are spawned as child processes speaking stdio. Pass the child a minimal environment plus exactly what the entry lists — never your host's full environment; your API keys live there.
- `{ url, headers? }` entries connect over Streamable HTTP. Support `${VAR}` interpolation so tokens stay in the environment, not the file.
- Adding a server to the config is an act of trust: it sees whatever the model sends it and its results go straight into the model's context. Say that in your own docs.

For protected HTTP servers, two tiers cover almost everything:

1. **Static credentials** — a bearer token or API key in `headers`. One line of config, no flow.
2. **OAuth** — when a server answers 401, the SDK drives discovery, dynamic client registration, PKCE, and token exchange through an `OAuthClientProvider` you supply ([client guide → Authentication](./client.md#authentication)). The host's share of the work (`host/auth.ts`): ask the user before opening a browser, run a loopback callback server, **verify the `state` parameter yourself** (the SDK does not), call `finishAuth()` on the transport that got the 401, then reconnect on a fresh transport with the same provider. Keep tokens in memory or in the platform keychain.

## Going further

Patterns worth knowing about once the basics work — none of them are in cli-client's code, deliberately:

- **Progressive discovery.** Hosts with many servers should not dump every tool into every request: filter by the conversation (per-server enable/disable, model-visible tool search, or a cheap relevance pass), lean on `server.getInstructions()` to tell the model what a server is for, and use the client's `listChanged` tracking to refresh lazily instead of re-listing on every turn.
- **Programmatic tool calling.** Nothing requires a model in the loop: `callTool` is just an API call, so hosts can run MCP tools from code — scheduled jobs, slash commands that hit a tool directly, or letting the model write code that calls tools through an execution environment instead of one round trip per call. The same namespacing and result-handling rules apply; only the caller changes.
- **Automatic resource loading.** The model-driven fallback from the resources section — list/read exposed as tools — is the simplest way to let the model pull in server data it was not handed up front.

## Security responsibilities of a host

A host sits between untrusted servers, a user's credentials, and a model that does what its context tells it. The short list cli-client implements and the guide above assumes:

- Treat every server-provided string as untrusted input: strip terminal escape sequences before rendering, label injected content with its origin, and cap its size.
- Decide a tool-consent policy: the spec expects a human in the loop able to deny tool invocations, so confirm destructive or side-effecting calls (or maintain a per-server allowlist). cli-client auto-executes because an interactive user watches every call and can Ctrl-C; an unattended host must not.
- Gate sampling on explicit user approval and cap its token spend; gate browser-opening (OAuth, URL elicitation) the same way.
- Never hand a child server process your full environment, and keep API keys out of config files (`${VAR}` interpolation exists for this).
- Validate the OAuth `state` parameter, only hand `https:` (or loopback) authorization URLs to the browser, and never render attacker-controllable error descriptions from callbacks.
- Treat tool annotations (`readOnlyHint`, `destructiveHint`) as hints for UX, never as a security boundary.

## See also

- [`examples/cli-client`](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/cli-client) — the example this guide walks through; its README lists a scripted tour.
- [Client guide](./client.md) — the per-API reference for everything used here (connecting, auth, tools, resources, prompts, handlers, errors).
- [Client quickstart](./client-quickstart.md) — the smallest possible LLM-connected client (tools only, one server); cli-client is what it grows into.
- [Spec: client concepts](https://modelcontextprotocol.io/docs/learn/client-concepts) — the protocol-level view of the features wired here.
