---
shape: how-to
---

# Notifications

A **notification** is a one-way message your server pushes to a connected client; change notifications tell clients that a list or a resource they cached is stale.

## Send a list-changed notification

Start from a server with one tool.

```ts source="../../examples/guides/servers/notifications.examples.ts#notifications_server"
import { McpServer } from '@modelcontextprotocol/server';

const jobs = ['nightly-backup'];

const server = new McpServer({ name: 'jobs', version: '1.0.0' });

server.registerTool('list-jobs', { description: 'List the configured jobs' }, async () => ({
    content: [{ type: 'text', text: jobs.join('\n') }]
}));
```

Every notification on this page is observed by an in-memory `Client` connected to the server above — [Test a server](../testing.md) shows that wiring — which logs each notification method it receives. Push a tool-list change yourself when the tool set changes for a reason the registration API cannot see.

```ts source="../../examples/guides/servers/notifications.examples.ts#sendToolListChanged_basic"
server.sendToolListChanged();
```

The client receives one `notifications/tools/list_changed` and re-fetches `tools/list`:

```
notifications/tools/list_changed
```

`sendPromptListChanged()` and `sendResourceListChanged()` are the prompt and resource siblings.

## Let registration changes notify for you

Hold on to the handle `registerTool` returns — every mutation through it sends the matching list-changed on its own.

```ts source="../../examples/guides/servers/notifications.examples.ts#registeredTool_update"
const report = server.registerTool('run-report', { description: 'Run the weekly report' }, async () => ({
    content: [{ type: 'text', text: 'report queued' }]
}));

report.update({ description: 'Run the weekly report and email it' });
report.disable();
```

Registering, updating, and disabling each sent a notification of its own — three more, none explicit:

```
notifications/tools/list_changed
notifications/tools/list_changed
notifications/tools/list_changed
```

`enable()` and `remove()` notify the same way, and the handles returned by `registerResource` and `registerPrompt` send `notifications/resources/list_changed` and `notifications/prompts/list_changed`. Most servers never call a `send*ListChanged()` method directly.

## Advertise the `listChanged` capability

`McpServer` advertised `tools: { listChanged: true }` the moment you registered a tool, and does the same for prompts and resources. Only the [low-level `Server`](../advanced/low-level-server.md) needs the capability declared up front.

```ts source="../../examples/guides/servers/notifications.examples.ts#Server_listChanged"
const lowLevel = new Server({ name: 'jobs', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
```

The low-level `Server` refuses to send a notification its capabilities do not cover — `sendToolListChanged()` throws without a `tools` capability — and clients use the `listChanged` flag to decide which notification types to ask for.

## Publish a resource update through the handler

On a 2026-07-28 connection, change notifications reach a client only on a [`subscriptions/listen`](../clients/subscriptions.md) stream the client opens — see [Protocol versions](../protocol-versions.md). Behind [`createMcpHandler`](../serving/http.md) the `McpServer` instance is per-request, so publish through the handler, not the instance: `notify` is a typed facade over the handler's open subscription streams.

```ts source="../../examples/guides/servers/notifications.examples.ts#handler_notifyResourceUpdated"
const handler = createMcpHandler(() => buildJobsServer());

// After config://app changes:
handler.notify.resourceUpdated('config://app');
```

Every client whose stream listed `config://app` receives `notifications/resources/updated` carrying that URI; `notify.toolsChanged()`, `notify.promptsChanged()`, and `notify.resourcesChanged()` publish the three list-changed types the same way. Per-resource updates have one extra gate: the server your factory builds must advertise `resources: { subscribe: true }`.

::: tip
On stdio, [`serveStdio`](../serving/stdio.md) routes the instance's own `send*ListChanged()` and `sendResourceUpdated()` calls onto its open subscription stream — no `notify` facade needed.
:::

::: info Coming from 2025-era subscriptions
A 2025-era connection delivers per-resource updates without a listen stream — [Resources](./resources.md#serve-per-resource-subscriptions) covers the server's subscription bookkeeping, [Subscriptions](../clients/subscriptions.md#fall-back-to-legacy-per-resource-subscribe) the client call, and [Protocol versions](../protocol-versions.md) the era split.
:::

## Pick an event bus for multi-process deployments

The `bus` option accepts any `ServerEventBus`; `InMemoryServerEventBus` is what `createMcpHandler` builds when you omit it.

```ts source="../../examples/guides/servers/notifications.examples.ts#createMcpHandler_bus"
const bus = new InMemoryServerEventBus();

const shared = createMcpHandler(() => buildJobsServer(), { bus });
```

The in-memory bus never leaves the process, so one process needs nothing more. Run more than one and you implement the two-method `ServerEventBus` interface — `publish` and `subscribe` — over your own pub/sub backend, then pass the same instance to every handler; see [Sessions, state, and scaling](../serving/sessions-state-scaling.md).

## Recap

- `sendToolListChanged()`, `sendPromptListChanged()`, and `sendResourceListChanged()` push a list-changed notification to connected clients.
- Registering, updating, enabling, disabling, or removing through a registration handle sends the matching list-changed for you.
- `McpServer` advertises `listChanged` as you register; only the low-level `Server` declares it up front.
- Behind `createMcpHandler`, publish through `handler.notify`; delivery reaches every open subscription stream that opted in.
- One process needs no `bus`; more than one shares a `ServerEventBus`.
