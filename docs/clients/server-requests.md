---
status: scaffold
shape: how-to
---
# Handle requests from the server

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Sampling/elicitation handlers; era unification told once via one cross-link.
teaches: Client capabilities option, Client.setRequestHandler, elicitation/create handler, sampling/createMessage handler, getSupportedElicitationModes, ClientOptions.inputRequired
source: mined from docs/client.md "Handling server-initiated requests", "Sampling", "Elicitation", "Manual multi-round-trip handling"
-->

## Declare what your client can do

<!-- teaches: ClientCapabilities via the Client constructor's options | salvage: docs/client.md "Handling server-initiated requests" (capabilities_declaration) -->

```ts
// draft - API verified against packages/client/src/client/client.ts (Client constructor, ClientOptions.capabilities)
import { Client } from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'my-client', version: '1.0.0' },
  {
    capabilities: {
      sampling: {},
      elicitation: { form: {} },
    },
  }
);
```

<!-- result: the server only sends a request your client declared a capability for; the SDK enforces this on both sides. -->

## Handle an elicitation request

<!-- teaches: client.setRequestHandler('elicitation/create', ...), form vs URL mode, action accept/decline/cancel | salvage: docs/client.md "Elicitation" -->
<!-- code: setRequestHandler('elicitation/create') branching on request.params.mode, returning { action: 'accept', content } or { action: 'decline' } -->

## Handle a sampling request

<!-- teaches: client.setRequestHandler('sampling/createMessage', ...) | salvage: docs/client.md "Sampling" -->
<!-- code: setRequestHandler('sampling/createMessage') returning { model, role, content } from your LLM call -->
<!-- aside: ::: warning — sampling is deprecated (SEP-2577); link clients/roots.md? no — link /protocol-versions for the era story and the servers/sampling.md banner for the sunset -->

## Register each handler once

<!-- teaches: era unification — handlers are era-transparent (older push requests vs an input_required round trip reach the same handler); the page's SINGLE era cross-link | salvage: docs/client.md "Handling server-initiated requests" (era paragraph), "Manual multi-round-trip handling" -->
<!-- code: none — one ::: info container: "How these handlers are delivered differs by protocol version — see /protocol-versions." Nothing else era-shaped on this page. -->

## Cap or disable automatic fulfilment

<!-- teaches: ClientOptions.inputRequired ({ autoFulfill, maxRounds }), INPUT_REQUIRED_ROUNDS_EXCEEDED | salvage: docs/client.md "Manual multi-round-trip handling (2026-07-28)" -->
<!-- code: new Client(info, { inputRequired: { maxRounds: 3 } }) -->

## Recap

<!-- the claims this page will prove:
- Declare a capability in the Client constructor or the server never sends that request.
- setRequestHandler('elicitation/create') and setRequestHandler('sampling/createMessage') are the two handlers; each returns a plain result object.
- Register the handler once; the SDK delivers it the same way on every protocol version (one cross-link to /protocol-versions).
- inputRequired on ClientOptions caps the automatic interactive rounds.
-->
