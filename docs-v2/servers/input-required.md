---
status: scaffold
shape: how-to
---
# input_required

<!-- SCAFFOLD - structure only; prose comes in a later tranche.
scope: Handle input_required (multi-round-trip requests).
teaches: inputRequired, inputRequired.elicit/elicitUrl/createMessage/listRoots, acceptedContent, ctx.mcpReq.inputResponses, ctx.mcpReq.requestState, createRequestStateCodec
source: mined from docs/server.md "Requesting input on 2026-07-28: input_required" + "Carrying state across rounds: requestState"
-->

## Return `input_required` instead of pushing a request
<!-- teaches: the inversion - the handler RETURNS the embedded request and the client retries the call with the responses | salvage: docs/server.md "Server-initiated requests" intro + "Requesting input on 2026-07-28" (registerTool_inputRequired) -->

```ts
// draft - API verified against packages/core-internal/src/shared/inputRequired.ts (inputRequired/acceptedContent, lines 120/147)
server.registerTool(
  'deploy',
  {
    description: 'Deploy after user confirmation',
    inputSchema: z.object({ env: z.string() }),
  },
  async ({ env }, ctx) => {
    const confirmed = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, 'confirm');
    if (confirmed?.confirm !== true) {
      return inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Deploy to ${env}?`,
            requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean' } }, required: ['confirm'] },
          }),
        },
      });
    }
    return { content: [{ type: 'text', text: `Deployed to ${env}` }] };
  }
);
```
<!-- result: round 1 returns resultType 'input_required'; the client answers and retries; round 2 returns the tool result. -->

## Read the responses on re-entry
<!-- teaches: ctx.mcpReq.inputResponses + acceptedContent(key) (typed, schema-or-cast); responses are untrusted input | source: packages/core-internal/src/shared/inputRequired.ts acceptedContent -->
<!-- code: acceptedContent with a Zod schema overload, plus the rejected/declined branch -->

## Write the handler write-once
<!-- teaches: the pattern - on every entry read what already arrived, ask only for what is still missing; never branch on era | salvage: docs/server.md "Requesting input on 2026-07-28" -->
<!-- code: the same handler asking for two inputs across two rounds, each guarded by acceptedContent -->

## Pick the embedded request kind
<!-- teaches: inputRequired.elicit (form), inputRequired.elicitUrl (URL), inputRequired.createMessage (sampling), inputRequired.listRoots() | source: packages/core-internal/src/shared/inputRequired.ts InputRequiredBuilder -->
<!-- code: one inputRequests map naming all four builders -->

## Carry state across rounds with `requestState`
<!-- teaches: nothing survives between rounds on the server; mint an opaque requestState, read it back with ctx.mcpReq.requestState<State>() | salvage: docs/server.md "Carrying state across rounds: requestState" (requestState_mintDecode) -->
<!-- code: mint requestState alongside the second-round request; read it on re-entry -->

## Protect `requestState` with the codec
<!-- teaches: requestState round-trips through the client and is attacker-controlled; createRequestStateCodec (HMAC-SHA256) + the ServerOptions.requestState.verify hook; mint only what earlier rounds proved | salvage: docs/server.md requestState IMPORTANT box (requestState_codec) -->
<!-- code: createRequestStateCodec({ key, ttlSeconds }) wired into ServerOptions.requestState.verify -->
<!-- ::: warning placeholder: signed, not encrypted; tampered/expired state answers -32602 -->

## Let the shim serve older clients
<!-- teaches: the on-by-default legacy shim fulfils input_required returns over the older push channels, so write-once handlers serve every connection | salvage: docs/server.md "Requesting input on 2026-07-28" closing paragraph -->
<!-- code: none; the era detail is ONE line linking /protocol-versions and the support guide -->

## Recap
<!-- the claims this page will prove:
- On 2026-07-28 a handler asks for input by RETURNING inputRequired(...); the client retries with the responses.
- inputRequired carries inputRequests and/or requestState; it throws if it has neither.
- acceptedContent(ctx.mcpReq.inputResponses, key) reads what a previous round produced; treat it as untrusted.
- Write-once handlers re-derive their position on every entry instead of remembering it.
- requestState is the only cross-round memory; sign it with createRequestStateCodec and mint only what was proved.
- The legacy shim makes the same handler work for older clients.
-->
