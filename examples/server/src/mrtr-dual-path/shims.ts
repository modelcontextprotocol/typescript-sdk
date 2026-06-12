/**
 * MRTR dual-path exploration — shared shims.
 *
 * This file extends the types from #1597's mrtr-backcompat/shims.ts with the
 * machinery needed to demonstrate five approaches to the "top-left quadrant"
 * from the SEP-2322 thread (comment 4083481545): a server that CAN hold SSE,
 * talking to a 2025-11 client, running MRTR-era tool code.
 *
 * Everything here is a stand-in for what the SDK would eventually provide.
 * None of it is production-grade; the point is to make the API surface area
 * of each option concrete enough to compare.
 *
 * Builds on: typescript-sdk#1597 (pcarleton's mrtr-backcompat demos).
 * See that PR's shims.ts for the baseline IncompleteResult / InputRequests
 * types — those are copied here unchanged so this folder is self-contained.
 */

import type { CallToolResult, ElicitRequestFormParams, ElicitResult, ServerContext } from '@modelcontextprotocol/server';

// ───────────────────────────────────────────────────────────────────────────
// Baseline MRTR types (copied from #1597 — see that PR for full commentary)
// ───────────────────────────────────────────────────────────────────────────

export type InputRequest = {
    method: 'elicitation/create';
    params: ElicitRequestFormParams;
};

export type InputRequests = { [key: string]: InputRequest };
export type InputResponses = { [key: string]: { result: ElicitResult } };

export interface IncompleteResult {
    inputRequests?: InputRequests;
    requestState?: string;
}

export interface MrtrParams {
    inputResponses?: InputResponses;
    requestState?: string;
}

export type MrtrToolResult = CallToolResult | IncompleteResult;

export function isIncomplete(r: MrtrToolResult): r is IncompleteResult {
    return ('inputRequests' in r && r.inputRequests !== undefined) || ('requestState' in r && r.requestState !== undefined);
}

export function elicitForm(params: Omit<ElicitRequestFormParams, 'mode'>): InputRequest {
    return { method: 'elicitation/create', params: { mode: 'form', ...params } };
}

export function acceptedContent<T extends Record<string, unknown>>(responses: InputResponses | undefined, key: string): T | undefined {
    const entry = responses?.[key];
    if (!entry) return undefined;
    const { result } = entry;
    if (result.action !== 'accept' || !result.content) return undefined;
    return result.content as T;
}

// ───────────────────────────────────────────────────────────────────────────
// New for dual-path: negotiated version stand-in
// ───────────────────────────────────────────────────────────────────────────

/**
 * The two protocol versions the demos care about.
 *
 * Real SDK would surface the negotiated version from the initialize handshake.
 * Today's SDK does track it internally but doesn't expose it to tool handlers,
 * so we read it from an env var to keep the demos runnable.
 */
export type ProtocolVersion = '2025-11' | '2026-06';

export const MRTR_MIN_VERSION: ProtocolVersion = '2026-06';

/**
 * Stand-in for `ctx.protocolVersion` or similar.
 *
 * Drive with `DEMO_PROTOCOL_VERSION=2025-11 pnpm tsx optionAShimMrtrCanonical.ts` to simulate
 * an old-client session against the same handler code.
 */
export function negotiatedVersion(): ProtocolVersion {
    const v = process.env.DEMO_PROTOCOL_VERSION;
    return v === '2025-11' ? '2025-11' : '2026-06';
}

export function supportsMrtr(v: ProtocolVersion = negotiatedVersion()): boolean {
    return v >= MRTR_MIN_VERSION;
}

// ───────────────────────────────────────────────────────────────────────────
// Option A machinery: SDK emulates the MRTR retry loop over SSE
// ───────────────────────────────────────────────────────────────────────────

/**
 * The signature an MRTR-native handler would have once the SDK threads
 * `inputResponses` / `requestState` through natively.
 *
 * This is what tool authors write under Option A. One function, re-entrant
 * by construction: check `inputResponses`, return `IncompleteResult` if
 * something's missing, compute the real result otherwise.
 */
export type MrtrHandler<TArgs> = (args: TArgs, mrtr: MrtrParams, ctx: ServerContext) => Promise<MrtrToolResult>;

/**
 * Wraps an MRTR-native handler so it also works for 2025-11 clients.
 *
 * Mechanism: when the negotiated version is pre-MRTR and the handler returns
 * `IncompleteResult`, this wrapper drives the retry loop *locally* — it sends
 * each `InputRequest` as a real `elicitation/create` over the SSE stream (via
 * the existing `ctx.mcpReq.elicitInput()`), collects the answers, and
 * re-invokes the handler with `inputResponses` populated. Repeat until the
 * handler returns a complete result.
 *
 * This is the "⚠️ clunky but possible" shim from the comment's matrix. The
 * tool author doesn't see the loop; they write MRTR-native code and it
 * transparently works for old clients too.
 *
 * This is only valid on server infra that can actually hold SSE — the
 * `ctx.mcpReq.elicitInput()` call below is a real SSE round-trip. On a
 * horizontally-scaled deployment that can't (the whole reason to adopt
 * MRTR in the first place), this shim fails at runtime when an old client
 * connects — the elicit goes out on a stream the LB has already dropped,
 * or was never held open. Nothing at registration time catches that; it's
 * a deployment-time constraint living far from the tool code. If that's
 * the deployment, use option E instead.
 *
 * Hidden cost: the handler is silently re-invoked. The MRTR shape makes that
 * safe *by construction* (re-entry point is explicit — the `if (!prefs)`
 * guard), but it's still invisible machinery.
 */
export function sseRetryShim<TArgs>(mrtrHandler: MrtrHandler<TArgs>): (args: TArgs, ctx: ServerContext) => Promise<CallToolResult> {
    return async (args, ctx) => {
        // Fast path: new client — just pass IncompleteResult through.
        // (In the real SDK this would emit JSONRPCIncompleteResultResponse on the wire.)
        if (supportsMrtr()) {
            const result = await mrtrHandler(args, {}, ctx);
            return wrap(result);
        }

        // Old client: drive the retry loop locally, using real SSE for each elicit.
        const responses: InputResponses = {};
        let requestState: string | undefined;

        // Bounded to catch handlers that never converge. A well-formed MRTR handler
        // asks for strictly fewer things each round; an unbounded loop is a bug.
        for (let round = 0; round < 8; round++) {
            const result = await mrtrHandler(args, { inputResponses: responses, requestState }, ctx);

            if (!isIncomplete(result)) {
                return result;
            }

            requestState = result.requestState;

            // No new questions but still incomplete: nothing more we can do here.
            // Return a tool-level error rather than looping on an empty ask.
            if (!result.inputRequests || Object.keys(result.inputRequests).length === 0) {
                return errorResult('Tool returned IncompleteResult with no inputRequests on a pre-MRTR session.');
            }

            // Fulfil each InputRequest via the *existing* SSE elicitation path.
            // This is the one place the shim actually needs SSE-capable infra:
            // `ctx.mcpReq.elicitInput()` issues `elicitation/create` on the POST
            // response stream and blocks until the client answers.
            for (const [key, req] of Object.entries(result.inputRequests)) {
                const answer = await ctx.mcpReq.elicitInput(req.params);
                responses[key] = { result: answer };
            }
        }

        return errorResult('MRTR retry loop exceeded round limit (handler never converged).');
    };
}

// ───────────────────────────────────────────────────────────────────────────
// Option B machinery: exception-based shim, `await elicit()` canonical
// ───────────────────────────────────────────────────────────────────────────

/**
 * Sentinel thrown by `elicit()` when the session is MRTR-capable and the
 * answer wasn't pre-supplied in `inputResponses`.
 *
 * Control-flow-by-exception: the shim catches this at the top of the handler
 * wrapper, packages it as `IncompleteResult`, and returns. On retry the
 * handler runs *from the top again* and this time `elicit()` finds the answer.
 */
export class NeedsInputSignal extends Error {
    constructor(public readonly inputRequests: InputRequests) {
        super('NeedsInputSignal (control flow, not an error)');
    }
}

/**
 * The `await`-able elicit function for Option B handlers.
 *
 * - Pre-MRTR session → real SSE elicitation, blocks inline (today's behaviour)
 * - MRTR session, answer present → return it
 * - MRTR session, answer absent → throw NeedsInputSignal
 *
 * The third case is the footgun. The handler author wrote `await elicit(...)`
 * and assumed linear control flow. On MRTR retry, *everything above this line
 * runs again*. If that includes a mutation — a DB write, an HTTP POST — it
 * happens twice. The MRTR shape surfaces re-entry in the source text
 * (`if (!prefs) return`); this shape hides it behind `await`.
 */
export function makeElicit(ctx: ServerContext, mrtr: MrtrParams) {
    return async function elicit<T extends Record<string, unknown>>(
        key: string,
        params: Omit<ElicitRequestFormParams, 'mode'>
    ): Promise<T | undefined> {
        // Old client: native SSE, no trickery.
        if (!supportsMrtr()) {
            const result = await ctx.mcpReq.elicitInput({ mode: 'form', ...params });
            if (result.action !== 'accept' || !result.content) return undefined;
            return result.content as T;
        }

        // New client: check inputResponses first.
        const preSupplied = acceptedContent<T>(mrtr.inputResponses, key);
        if (preSupplied) return preSupplied;

        // Answer not pre-supplied → signal the shim to emit IncompleteResult.
        // Everything on the stack between here and `mrtrExceptionShim`'s catch
        // unwinds. On retry the handler re-executes from line one.
        throw new NeedsInputSignal({ [key]: elicitForm(params) });
    };
}

/**
 * Wrap an `await elicit()`-style handler so it emits `IncompleteResult` on
 * MRTR sessions.
 *
 * Catches `NeedsInputSignal`, packages as `IncompleteResult`. That's it.
 * The hidden re-entry on retry is the trade — zero migration for existing
 * tools, silent double-execution of everything above the await.
 */
export function mrtrExceptionShim<TArgs>(
    handler: (args: TArgs, elicit: ReturnType<typeof makeElicit>, ctx: ServerContext) => Promise<CallToolResult>
): (args: TArgs, mrtr: MrtrParams, ctx: ServerContext) => Promise<MrtrToolResult> {
    return async (args, mrtr, ctx) => {
        const elicit = makeElicit(ctx, mrtr);
        try {
            return await handler(args, elicit, ctx);
        } catch (error) {
            if (error instanceof NeedsInputSignal) {
                return { inputRequests: error.inputRequests };
            }
            throw error;
        }
    };
}

// ───────────────────────────────────────────────────────────────────────────
// Option D machinery: dual registration
// ───────────────────────────────────────────────────────────────────────────

/**
 * Two handlers, one per protocol era. SDK dispatches by negotiated version.
 * No shim, no magic — the author wrote both and the SDK just picks.
 */
export interface DualPathHandlers<TArgs> {
    mrtr: MrtrHandler<TArgs>;
    sse: (args: TArgs, ctx: ServerContext) => Promise<CallToolResult>;
}

export function dispatchByVersion<TArgs>(
    handlers: DualPathHandlers<TArgs>
): (args: TArgs, mrtr: MrtrParams, ctx: ServerContext) => Promise<MrtrToolResult> {
    return async (args, mrtr, ctx) => {
        if (supportsMrtr()) {
            return handlers.mrtr(args, mrtr, ctx);
        }
        return handlers.sse(args, ctx);
    };
}

// ───────────────────────────────────────────────────────────────────────────
// Shared helpers
// ───────────────────────────────────────────────────────────────────────────

export function errorResult(message: string): CallToolResult {
    return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Smuggle `IncompleteResult` through the current `registerTool` signature
 * as a JSON text block. Same hack as #1597 — real SDK would emit
 * `JSONRPCIncompleteResultResponse` at the protocol layer.
 */
export function wrap(result: MrtrToolResult): CallToolResult {
    if (!isIncomplete(result)) return result;
    return {
        content: [{ type: 'text', text: JSON.stringify({ __mrtrIncomplete: true, ...result }) }]
    };
}

/**
 * Stand-in for reading MRTR params off the retry request.
 * See #1597 for why this rides on `arguments._mrtr` today.
 */
export function readMrtr(args: Record<string, unknown> | undefined): MrtrParams {
    const raw = (args as { _mrtr?: MrtrParams } | undefined)?._mrtr;
    return raw ?? {};
}

// ───────────────────────────────────────────────────────────────────────────
// requestState encode/decode — used by options F and G
//
// DEMO ONLY: plain base64 JSON. Real SDK MUST HMAC-sign this blob,
// because the client can otherwise forge step-done / once-executed
// markers and skip the guards entirely. Per-session key derived from
// initialize keeps it stateless. Without signing, F and G's safety
// story is advisory, not enforced.
// ───────────────────────────────────────────────────────────────────────────

export function encodeState(state: unknown): string {
    return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

export function decodeState<T>(blob: string | undefined): T | undefined {
    if (!blob) return undefined;
    try {
        return JSON.parse(Buffer.from(blob, 'base64').toString('utf8')) as T;
    } catch {
        return undefined;
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Option F machinery: ctx.once — idempotency guard for side-effects
// ───────────────────────────────────────────────────────────────────────────

interface OnceState {
    executed: string[];
}

/**
 * MRTR context with a `once` guard. Handler code looks like Option A/E
 * (monolithic, guard-first) but side-effects above or below the guard
 * can be wrapped to guarantee at-most-once execution across retries.
 *
 * Opt-in: an unwrapped `db.write()` above the guard still fires twice.
 * The footgun isn't eliminated — it's made *visually distinct* from
 * safe code, which is reviewable. Use this when ToolBuilder is overkill
 * (single elicitation, one side-effect) or when the side-effect genuinely
 * needs to happen before the guard.
 *
 * Crash window: if the server dies between `fn()` completing and
 * `requestState` reaching the client, the next invocation re-executes
 * `fn()`. At-most-once under normal operation, not crash-safe. For
 * financial operations use external idempotency (request ID as DB
 * unique constraint).
 */
export class MrtrCtx {
    private executed: Set<string>;

    constructor(private readonly mrtr: MrtrParams) {
        const prior = decodeState<OnceState>(mrtr.requestState);
        this.executed = new Set(prior?.executed);
    }

    get inputResponses(): InputResponses | undefined {
        return this.mrtr.inputResponses;
    }

    /**
     * Run `fn` at most once across all MRTR rounds for this tool call.
     * On subsequent rounds where `key` is marked done in requestState,
     * skip `fn` entirely. Makes the hazard visible at the call site.
     */
    once(key: string, fn: () => void): void {
        if (this.executed.has(key)) return;
        fn();
        this.executed.add(key);
    }

    /**
     * Serialize executed-keys into requestState for the next round.
     * Call this when building an IncompleteResult so the guard holds
     * across retry. Without this, `once` is a no-op on retry.
     */
    incomplete(inputRequests: InputRequests): IncompleteResult {
        return {
            inputRequests,
            requestState: encodeState({ executed: [...this.executed] } satisfies OnceState)
        };
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Option G machinery: ToolBuilder — Marcelo's explicit step decomposition
// ───────────────────────────────────────────────────────────────────────────

interface BuilderState {
    done: string[];
}

/**
 * An `incomplete_step` function. Receives args + all `inputResponses`
 * collected so far. Returns either a new `IncompleteResult` (needs more
 * input) or a data object to accumulate and pass to the next step.
 *
 * MUST be idempotent — this can re-run if the step before it wasn't
 * the most-recently-completed one. Side-effects belong in `endStep`.
 */
export type IncompleteStep<TArgs> = (args: TArgs, inputs: InputResponses) => IncompleteResult | Record<string, unknown>;

/**
 * The `end_step` function. Receives args + the merged data from all
 * prior steps. Runs exactly once, when every `incomplete_step` has
 * returned data (not `IncompleteResult`). This is the safe zone —
 * put side-effects here.
 */
export type EndStep<TArgs> = (args: TArgs, collected: Record<string, unknown>) => CallToolResult;

/**
 * Explicit step builder. Eliminates the "above the guard" zone by
 * decomposing the monolithic handler into discrete step functions.
 * `endStep` is structurally unreachable until all elicitations
 * complete — the SDK enforces that via `requestState` tracking,
 * not developer discipline.
 *
 * Steps are named (not ordinal) so reordering them during development
 * doesn't silently remap data. Each `incompleteStep` name must be
 * unique; the SDK would throw at build time on duplicates (demo skips
 * that check).
 *
 * Boilerplate vs Option A/E: two function definitions + `.build()` to
 * replace a 3-line guard. Worth it at 3+ elicitation rounds; overkill
 * for single-question tools where `ctx.once` (Option F) is lighter.
 */
export class ToolBuilder<TArgs> {
    private steps: Array<{ name: string; fn: IncompleteStep<TArgs> }> = [];
    private end?: EndStep<TArgs>;

    incompleteStep(name: string, fn: IncompleteStep<TArgs>): this {
        this.steps.push({ name, fn });
        return this;
    }

    endStep(fn: EndStep<TArgs>): this {
        this.end = fn;
        return this;
    }

    build(): MrtrHandler<TArgs> {
        const steps = this.steps;
        const end = this.end;
        if (!end) throw new Error('ToolBuilder: endStep is required');

        return async (args, mrtr) => {
            const prior = decodeState<BuilderState>(mrtr.requestState);
            const done = new Set(prior?.done);
            const inputs = mrtr.inputResponses ?? {};
            const collected: Record<string, unknown> = {};

            for (const step of steps) {
                const result = step.fn(args, inputs);
                if ('inputRequests' in result || 'requestState' in result) {
                    // Step needs more input. Encode which steps are done
                    // so retry can fast-forward past them.
                    return {
                        ...(result as IncompleteResult),
                        requestState: encodeState({ done: [...done] } satisfies BuilderState)
                    };
                }
                // Step returned data. Merge and mark done.
                Object.assign(collected, result);
                done.add(step.name);
            }

            // All steps complete — this line runs exactly once per tool call.
            return end(args, collected);
        };
    }
}

// ───────────────────────────────────────────────────────────────────────────
// Option H machinery: ContinuationStore — keep `await ctx.elicit()` genuine
//
// Counterpart to python-sdk#2322's linear.py. The Option B footgun was:
// `await elicit()` LOOKS like a suspension point but is actually a re-entry
// point, so everything above it runs twice. This fixes that by making it a
// REAL suspension point — the Promise chain is held in memory across MRTR
// rounds, keyed by request_state.
//
// Trade-off: the server holds the frame between rounds. Client sees pure
// MRTR (no SSE, independent HTTP requests), but the server is stateful
// within a tool call. Horizontal scale needs sticky routing on the
// request_state token. Same operational shape as Option A's SSE hold,
// without the long-lived connection.
// ───────────────────────────────────────────────────────────────────────────

type LinearAsk = IncompleteResult | CallToolResult;

/**
 * One-shot Promise + its resolver. After `resolve` fires, the caller
 * swaps in a fresh channel for the next round. Node's event loop keeps
 * the pending Promise alive; that's what holds the continuation.
 */
interface Channel<T> {
    next: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

function channel<T>(): Channel<T> {
    let resolve!: (v: T) => void;
    let reject!: (r?: unknown) => void;
    const next = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { next, resolve, reject };
}

/**
 * In-memory state for one suspended linear handler. Two channels:
 * `ask` carries IncompleteResult/CallToolResult from the handler to the
 * wrapper (and onward to the client); `answer` carries inputResponses
 * from the wrapper (the retry) back into the suspended `ctx.elicit()`.
 */
class Continuation {
    private askCh: Channel<LinearAsk> = channel();
    private answerCh: Channel<InputResponses> = channel();

    ask(msg: LinearAsk): void {
        this.askCh.resolve(msg);
    }

    async nextAsk(): Promise<LinearAsk> {
        const msg = await this.askCh.next;
        this.askCh = channel();
        return msg;
    }

    answer(responses: InputResponses): void {
        this.answerCh.resolve(responses);
    }

    async nextAnswer(): Promise<InputResponses> {
        const responses = await this.answerCh.next;
        this.answerCh = channel();
        return responses;
    }

    abort(reason: string): void {
        this.answerCh.reject(new Error(reason));
    }
}

/**
 * Owns the token → continuation map. One per server process. Unlike the
 * Python version this isn't a context manager — Node's event loop keeps
 * pending Promises alive without an explicit task group. TTL is a simple
 * setTimeout that aborts the frame if the client never retries.
 */
export class ContinuationStore {
    private frames = new Map<string, { cont: Continuation; timer: ReturnType<typeof setTimeout> }>();

    constructor(private readonly ttlMs = 300_000) {}

    start(token: string, runner: (cont: Continuation) => Promise<void>): Continuation {
        const cont = new Continuation();
        const timer = setTimeout(() => this.expire(token), this.ttlMs);
        this.frames.set(token, { cont, timer });

        // Fire-and-forget. The Promise is held alive by the event loop;
        // the pending `cont.nextAnswer()` inside is what keeps the frame.
        void runner(cont).finally(() => this.delete(token));

        return cont;
    }

    get(token: string): Continuation | undefined {
        const entry = this.frames.get(token);
        if (!entry) return undefined;
        // Reset TTL on each access — the client is still driving.
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this.expire(token), this.ttlMs);
        return entry.cont;
    }

    private expire(token: string): void {
        const entry = this.frames.get(token);
        if (!entry) return;
        entry.cont.abort(`Continuation ${token} expired after ${this.ttlMs}ms`);
        this.frames.delete(token);
    }

    private delete(token: string): void {
        const entry = this.frames.get(token);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.frames.delete(token);
    }
}

/**
 * Thrown inside a linear handler when the user declines/cancels.
 * The wrapper catches this and emits a non-error CallToolResult.
 */
export class ElicitDeclined extends Error {
    constructor(public readonly action: string) {
        super(`Elicitation ${action}`);
    }
}

/**
 * The `ctx` handed to a linear handler. `await ctx.elicit()` genuinely
 * suspends — the await parks on `cont.nextAnswer()` until the next MRTR
 * round delivers the answer. No re-entry, no double-execution.
 */
export class LinearCtx {
    private counter = 0;

    constructor(private readonly cont: Continuation) {}

    /**
     * Send one or more input requests in a single round; returns the
     * full responses dict on resume. Lower-level than `elicit()` —
     * hand-rolled schemas, no decline handling, multiple asks batched.
     */
    async ask(inputRequests: InputRequests): Promise<InputResponses> {
        this.cont.ask({ inputRequests });
        return this.cont.nextAnswer();
    }

    /**
     * Ask one elicitation question. Suspends until the answer arrives
     * on a later round. Throws `ElicitDeclined` if the user cancels.
     */
    async elicit<T extends Record<string, unknown>>(
        message: string,
        requestedSchema: ElicitRequestFormParams['requestedSchema']
    ): Promise<T> {
        const key = `q${this.counter++}`;
        const responses = await this.ask({ [key]: elicitForm({ message, requestedSchema }) });
        const result = responses[key]?.result;
        if (!result || result.action !== 'accept' || !result.content) {
            throw new ElicitDeclined(result?.action ?? 'cancel');
        }
        return result.content as T;
    }
}

/**
 * Signature of a linear handler: SSE-era shape, runs exactly once
 * front-to-back. Returning a string is shorthand for single TextContent.
 */
export type LinearHandler<TArgs> = (args: TArgs, ctx: LinearCtx) => Promise<CallToolResult | string>;

/**
 * Wrap a linear `await ctx.elicit()` handler into a standard MRTR
 * handler. Round 1 spawns the handler as a detached Promise; `elicit()`
 * sends IncompleteResult through the ask channel and parks on the answer
 * channel. Round 2's retry resolves the answer channel; the handler
 * continues from where it stopped. No re-entry.
 *
 * Zero migration from SSE-era code, zero footgun. The price: the server
 * holds the frame in memory, so horizontal scale needs sticky routing
 * on `request_state`. If you need true statelessness, use E/F/G instead.
 */
export function linearMrtr<TArgs>(handler: LinearHandler<TArgs>, store: ContinuationStore): MrtrHandler<TArgs> {
    return async (args, mrtr) => {
        const token = mrtr.requestState;

        if (token === undefined) {
            return start(args, handler, store);
        }
        return resume(token, mrtr.inputResponses ?? {}, store);
    };
}

async function start<TArgs>(args: TArgs, handler: LinearHandler<TArgs>, store: ContinuationStore): Promise<MrtrToolResult> {
    const token = crypto.randomUUID();
    const cont = store.start(token, async c => {
        const linearCtx = new LinearCtx(c);
        try {
            const result = await handler(args, linearCtx);
            const wrapped: CallToolResult = typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result;
            c.ask(wrapped);
        } catch (error) {
            if (error instanceof ElicitDeclined) {
                c.ask({ content: [{ type: 'text', text: `Cancelled (${error.action}).` }] });
                return;
            }
            c.ask({ content: [{ type: 'text', text: String(error) }], isError: true });
        }
    });
    return next(token, cont);
}

async function resume(token: string, responses: InputResponses, store: ContinuationStore): Promise<MrtrToolResult> {
    const cont = store.get(token);
    if (!cont) {
        return errorResult('Continuation expired or unknown. Retry the tool call from scratch.');
    }
    cont.answer(responses);
    return next(token, cont);
}

async function next(token: string, cont: Continuation): Promise<MrtrToolResult> {
    const msg = await cont.nextAsk();
    if (isIncomplete(msg)) {
        return { ...msg, requestState: token };
    }
    return msg;
}
