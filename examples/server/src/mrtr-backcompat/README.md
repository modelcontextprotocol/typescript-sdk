# MRTR Backwards-Compatibility Exploration

**SEP:** [Multi Round-Trip Requests — transports-wg#12](https://github.com/modelcontextprotocol/transports-wg/pull/12) **Discussion anchor:** the ["Backward Compatibility" section](https://github.com/modelcontextprotocol/transports-wg/pull/12/files#diff-) and review thread at
line ~1160 ("this ideally is doing a lot of heavy lifting").

## What this folder is

Four side-by-side demos that show how an existing `await elicitInput(...)`-style tool handler migrates under MRTR, bucketed by how painful the migration is:

| #   | Scenario                                     | Hazard of naive retry                      | Migration cost                     | requestState? | Tasks? |
| --- | -------------------------------------------- | ------------------------------------------ | ---------------------------------- | ------------- | ------ |
| 1   | **Simple retry** — idempotent lookup         | Wasted compute only                        | Trivial (mechanical inversion)     | No            | No     |
| 2   | **Continuation state** — multi-step dialogue | User re-prompted for answers already given | Moderate (handler → state machine) | Yes           | No     |
| 3   | **Persistent** — mutation before elicitation | Duplicate side-effects (e.g. two VMs)      | High (migrate to Tasks workflow)   | N/A           | Yes    |

Each demo registers a `<name>_before` tool (current SDK pattern) and a `<name>_after` tool (MRTR pattern, or a sketch thereof for #3), so you can diff the handler bodies directly.

## Files

| File                     | What it shows                                                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shims.ts`               | Local stand-ins for `IncompleteResult`, `InputRequests`/`InputResponses`, and helpers. Since the SDK doesn't thread `inputResponses`/`requestState` through yet, MRTR params ride on `arguments._mrtr` and `IncompleteResult` is smuggled out as a marked JSON text block. |
| `01SimpleRetry.ts`       | Weather lookup. One elicitation, no state worth carrying. Migration is "check for answer, else ask" — essentially mechanical.                                                                                                                                              |
| `02ContinuationState.ts` | ADO-style conditional-field cascade (mirrors the SEP's real-world example). Conditional branching: the second question only exists if the first answer was "Duplicate".                                                                                                    |
| `03TasksMigration.ts`    | VM provisioning — a mutation runs _before_ the elicitation. Demonstrates why MRTR's ephemeral workflow can't save this class of handler and sketches the Tasks shape it should move to. See `../simpleTaskInteractive.ts` for the full Tasks wiring.                       |
| `04FlightBooking.ts`     | Three-step booking wizard. Linear accumulation: `requestState` grows monotonically each round (route → route+dates → full itinerary). The most common shape of multi-elicitation tool in practice; shows the migration is simpler than 02's branching case.                |

## The three-tier classification, as a decision tree

```
Does the handler mutate external state before the first elicitation?
│
├─ Yes  →  Scenario 3: migrate to Tasks (input_required → tasks/input_response)
│
└─ No   →  Does the handler ask >1 question where later questions depend on earlier answers?
           │
           ├─ Yes  →  Scenario 2: ephemeral MRTR with requestState
           │          (02 for conditional branching, 04 for linear wizard)
           │
           └─ No   →  Scenario 1: ephemeral MRTR, no requestState needed
```

In practice most existing tools fall into bucket 1. Bucket 2 covers wizard-style flows. Bucket 3 is rare but is the case where a naive "just retry" story actively breaks things — and the SDK-level backcompat shim (if we build one) must detect and reject or redirect these.

## Running the demos

```sh
# From repo root
pnpm tsx examples/server/src/mrtr-backcompat/01SimpleRetry.ts
pnpm tsx examples/server/src/mrtr-backcompat/02ContinuationState.ts
pnpm tsx examples/server/src/mrtr-backcompat/03TasksMigration.ts
pnpm tsx examples/server/src/mrtr-backcompat/04FlightBooking.ts
```

All four use stdio transport so they're easy to drive from the Inspector. The `_after` tools expect MRTR params under `arguments._mrtr = { inputResponses, requestState }` as a transport stand-in.

## What this exploration does NOT do

- **No transport changes.** `IncompleteResult` is encoded as a JSON text payload, not a real `JSONRPCIncompleteResultResponse`.
- **No SDK-level backcompat shim.** The "after" handlers are hand-written. A follow-up would be: can the SDK wrap a legacy `await elicitInput()` handler so it behaves like bucket-1-or-2 automatically? That's the real question behind the review-thread concern.
- **No paired client.** You can craft the `_mrtr` argument manually in Inspector. A tiny demo client that auto-retries on the `__mrtrIncomplete` marker would be a nice next step.
