---
shape: how-to
---
# Handle requests from the server

## Declare what your client can do

Declare each **capability** in the `Client` constructor's options — a server only sends your client a request it declared a capability for, and the SDK enforces that on both sides.

```ts source="../../examples/guides/clients/server-requests.examples.ts#Client_capabilities"
import { Client } from '@modelcontextprotocol/client';

const client = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        capabilities: {
            sampling: {},
            elicitation: { form: {}, url: {} }
        }
    }
);
```

Every result quoted on this page comes from this client connected over an in-memory transport pair to a server whose tools elicit input and request sampling. [Test a server](../testing.md) shows that wiring; [Elicitation](../servers/elicitation.md) and [Sampling](../servers/sampling.md) show the server side.

::: tip
An empty `elicitation: {}` declares form mode only — `url` must be listed explicitly. `getSupportedElicitationModes`, exported from `@modelcontextprotocol/client`, turns any `elicitation` capability object into `{ supportsFormMode, supportsUrlMode }`.
:::

## Handle an elicitation request

A tool that calls `elicitInput` sends your client an `elicitation/create` request. Branch on `request.params.mode`: `'url'` carries a URL to open in the user's browser, and anything else is a form your client builds from `request.params.requestedSchema`.

```ts source="../../examples/guides/clients/server-requests.examples.ts#setRequestHandler_elicitation"
client.setRequestHandler('elicitation/create', async request => {
    if (request.params.mode === 'url') {
        // Open request.params.url in the user's browser; answer when they finish.
        return { action: 'accept' };
    }
    // Render request.params.requestedSchema as a form; return what the user entered.
    return { action: 'accept', content: { city: 'Lisbon' } };
});
```

`action` is the user's decision: `'accept'` carries the submitted `content`, `'decline'` and `'cancel'` carry nothing. Calling a tool that asks where to ship an order now round-trips through the form branch:

```
[ { type: 'text', text: 'Order placed: Travel mug ships to Lisbon.' } ]
```

::: tip
Form requests sent before `mode` existed omit it entirely — branch on `'url'` and treat everything else as a form, never on `mode === 'form'`.
:::

## Handle a sampling request

::: warning Deprecated — SEP-2577
Servers should call their LLM provider directly instead of sampling — see [Sampling](../servers/sampling.md). Keep this handler to support servers that have not migrated yet.
:::

A tool that calls `requestSampling` sends your client a `sampling/createMessage` request: a list of messages to run through a model your application controls.

```ts source="../../examples/guides/clients/server-requests.examples.ts#setRequestHandler_sampling"
client.setRequestHandler('sampling/createMessage', async request => {
    const lastMessage = request.params.messages.at(-1);
    console.log('Sampling request:', lastMessage?.content);

    // In production, run the messages through your model here.
    return {
        model: 'host-model',
        role: 'assistant',
        content: { type: 'text', text: 'One travel mug to Lisbon.' }
    };
});
```

Calling a tool that summarizes the order logs the prompt the server sent, and the tool result carries the handler's completion:

```
Sampling request: { type: 'text', text: 'Summarize this order: 1 Travel mug to Lisbon' }
[ { type: 'text', text: 'host-model: One travel mug to Lisbon.' } ]
```

## Register each handler once

Register each handler once, on the `Client` you construct. The same handler answers a request the server pushes to your client and a request the SDK fulfils for you inside a `callTool()` round — your code never sees the difference.

::: info
Which of those two delivery paths a connection uses depends on its protocol version — see [Protocol versions](../protocol-versions.md).
:::

## Cap or disable automatic fulfilment

When the SDK fulfils requests inside a call, the `inputRequired` option caps how many rounds it runs on your behalf.

```ts source="../../examples/guides/clients/server-requests.examples.ts#Client_inputRequired"
const client = new Client(
    { name: 'my-client', version: '1.0.0' },
    {
        capabilities: { sampling: {}, elicitation: { form: {}, url: {} } },
        inputRequired: { maxRounds: 3 }
    }
);
```

Past `maxRounds` (default 10) the call rejects with an `SdkError` coded `INPUT_REQUIRED_ROUNDS_EXCEEDED`. Set `autoFulfill: false` to turn the loop off entirely: a call that needs input rejects on its first round instead, and the round trips are yours to drive.

## Recap

- Declare a capability in the `Client` constructor or the server never sends that request.
- `setRequestHandler('elicitation/create')` branches on `mode` and returns the user's `action`, plus `content` on accept.
- `setRequestHandler('sampling/createMessage')` runs the messages through your model and returns `{ model, role, content }`.
- Register each handler once; it answers the request however the connection delivers it.
- `inputRequired` caps the automatic interactive rounds; `autoFulfill: false` disables them.
