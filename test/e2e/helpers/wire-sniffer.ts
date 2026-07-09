import {
    ClientNotificationSchema,
    ClientRequestSchema,
    ClientResultSchema,
    ServerNotificationSchema,
    ServerRequestSchema,
    ServerResultSchema
} from '@modelcontextprotocol/core-internal';
import type { Transport } from '@modelcontextprotocol/server';
import {
    isInputRequiredResult,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    isSpecType
} from '@modelcontextprotocol/server';

function isPlainRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export type WireParty = 'client' | 'server';

export interface SnifferOptions {
    /** Permit non-spec (vendor-extension) method names. Spec methods stay strict. */
    allowCustomMethods?: boolean;
    /** `false` → envelope check only (for tests that deliberately send malformed messages). */
    strictValidation?: boolean;
    /**
     * Permit `input_required` results as server output. Set automatically by
     * the wiring for the modern-era (2026-07-28) arms — multi-round-trip
     * results are not legal vocabulary on the 2025-era wire, so an
     * `input_required` leaking onto a legacy cell is flagged.
     */
    allowInputRequiredResults?: boolean;
}

const OUTBOUND = {
    client: {
        request: ClientRequestSchema,
        notification: ClientNotificationSchema,
        result: ClientResultSchema
    },
    server: {
        request: ServerRequestSchema,
        notification: ServerNotificationSchema,
        result: ServerResultSchema
    }
} as const;

/** Method names valid as an outbound request/notification for each party. */
const SPEC_METHODS: Record<WireParty, { request: Set<string>; notification: Set<string> }> = {
    client: { request: methodSet(ClientRequestSchema), notification: methodSet(ClientNotificationSchema) },
    server: { request: methodSet(ServerRequestSchema), notification: methodSet(ServerNotificationSchema) }
};

function methodSet(union: { options?: ReadonlyArray<{ shape?: { method?: { values?: ReadonlySet<unknown> } } }> }): Set<string> {
    const out = new Set<string>();
    for (const member of union.options ?? []) {
        for (const v of member.shape?.method?.values ?? []) {
            if (typeof v === 'string') out.add(v);
        }
    }
    return out;
}

function fail(party: WireParty, reason: string, msg: unknown): never {
    throw new Error(`[wire] ${party} sent an invalid message: ${reason}\n${JSON.stringify(msg, null, 2)}`);
}

/**
 * Assert a single message is valid for the given sending party.
 * @param msg the raw JSON-RPC message
 * @param party who put it on the wire (`client` outbound = ClientRequest/Notification/Result)
 */
export function assertWireMessage(msg: unknown, party: WireParty, opts: SnifferOptions = {}): void {
    if (!isSpecType.JSONRPCMessage(msg)) {
        fail(party, 'not a JSON-RPC message', msg);
    }
    if (opts.strictValidation === false) return;

    const schemas = OUTBOUND[party];

    if (isJSONRPCRequest(msg) || isJSONRPCNotification(msg)) {
        const kind = isJSONRPCRequest(msg) ? 'request' : 'notification';
        const method = (msg as { method: string }).method;
        if (!SPEC_METHODS[party][kind].has(method)) {
            if (opts.allowCustomMethods) return;
            fail(party, `non-spec ${kind} method '${method}' (pass { allowCustomMethods: true } if intentional)`, msg);
        }
        const params = (msg as { params?: unknown }).params;
        const r = schemas[kind].safeParse({ method, params });
        if (!r.success) {
            fail(party, `spec method '${method}' params do not conform: ${r.error.message}`, msg);
        }
        return;
    }

    if (isJSONRPCResultResponse(msg)) {
        const result = (msg as { result: unknown }).result;
        // Multi-round-trip results (protocol revision 2026-07-28) are valid
        // server output but deliberately NOT part of the neutral result union
        // (InputRequiredResultSchema lives alongside, never widening it).
        // Era-gated: only cells wired for the modern era opt in, so an
        // input_required on a 2025-era cell's wire is still flagged.
        if (party === 'server' && isInputRequiredResult(result)) {
            if (opts.allowInputRequiredResults === true) return;
            fail(party, `input_required result on a cell not opted into multi-round-trip`, msg);
        }
        // With content.default([]) restored, the neutral union accepts any
        // object via the CallToolResult member — so union conformance below
        // is a weak check. Era-gating for the other result families is
        // asserted here explicitly, by vocabulary.
        if (party === 'server' && isPlainRecord(result) && result.content === undefined) {
            for (const key of ['task', 'inputRequests', 'requestState']) {
                if (key in result) {
                    fail(party, `content-less result carrying '${key}' on a legacy cell`, msg);
                }
            }
        }
        const r = schemas.result.safeParse(result);
        if (!r.success) {
            // A result for a vendor-extension request legitimately won't match the spec union.
            if (opts.allowCustomMethods) return;
            fail(party, `result does not conform to any spec result: ${r.error.message}`, msg);
        }
        return;
    }

    if (isJSONRPCErrorResponse(msg)) return; // envelope already validated; error bodies are not method-specific
}

/**
 * Wrap a transport so every outbound `send` (validated as `party`) and inbound
 * `onmessage` (validated as the counterpart) is asserted. Returns the same
 * transport instance (monkey-patched in place).
 */
export function sniffTransport<T extends Transport>(transport: T, party: WireParty, opts: SnifferOptions = {}): T {
    const counterpart: WireParty = party === 'client' ? 'server' : 'client';

    const origSend = transport.send.bind(transport);
    transport.send = (message, sendOpts) => {
        assertWireMessage(message, party, opts);
        return origSend(message, sendOpts);
    };

    // `onmessage` is assigned by Protocol.connect() after we wrap. Intercept via
    // an accessor so we wrap whatever handler it installs, validating each
    // inbound message (sent by the counterpart) before passing it through.
    let handler: Transport['onmessage'];
    Object.defineProperty(transport, 'onmessage', {
        configurable: true,
        enumerable: true,
        get: () => handler,
        set: next => {
            handler = next
                ? (message, extra) => {
                      assertWireMessage(message, counterpart, opts);
                      return next(message, extra);
                  }
                : next;
        }
    });

    return transport;
}
