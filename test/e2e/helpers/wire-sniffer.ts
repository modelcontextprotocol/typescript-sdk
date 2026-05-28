/**
 * Wire-format sniffer: asserts every JSON-RPC message crossing a transport is a
 * well-formed MCP message for its direction.
 *
 * Validation runs against the SDK's runtime Zod schemas in `src/types.ts`
 * (`ClientRequestSchema`, `ServerResultSchema`, …). Those schemas are proven
 * equivalent to the spec-synced `src/spec.types.ts` by `test/spec.types.test.ts`
 * (mutual assignability + per-type completeness). So conformance here is
 * transitively conformance to the spec, with `spec.types.ts` as the anchor: if
 * the SDK schemas ever drift off-spec, that equivalence test goes red first.
 *
 * Two layers:
 *   1. JSON-RPC envelope (always) — request / notification / response / error.
 *   2. MCP shape (unless `strictValidation: false`) — the method is a spec
 *      method for the sender's direction and its params/result match the schema.
 *      Vendor-extension method names are rejected unless `allowCustomMethods`.
 */

import {
    ClientNotificationSchema,
    ClientRequestSchema,
    ClientResultSchema,
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    JSONRPCMessageSchema,
    ServerNotificationSchema,
    ServerRequestSchema,
    ServerResultSchema
} from '../../../src/types.js';
import type { Transport } from '../../../src/shared/transport.js';

export type WireParty = 'client' | 'server';

export interface SnifferOptions {
    /** Permit non-spec (vendor-extension) method names. Spec methods stay strict. */
    allowCustomMethods?: boolean;
    /** `false` → envelope check only (for tests that deliberately send malformed messages). */
    strictValidation?: boolean;
}

const OUTBOUND = {
    client: { request: ClientRequestSchema, notification: ClientNotificationSchema, result: ClientResultSchema },
    server: { request: ServerRequestSchema, notification: ServerNotificationSchema, result: ServerResultSchema }
} as const;

/** Method names valid as an outbound request/notification for each party. */
const SPEC_METHODS: Record<WireParty, { request: Set<string>; notification: Set<string> }> = {
    client: { request: methodSet(ClientRequestSchema), notification: methodSet(ClientNotificationSchema) },
    server: { request: methodSet(ServerRequestSchema), notification: methodSet(ServerNotificationSchema) }
};

function methodSet(union: { options?: ReadonlyArray<{ shape?: { method?: { value?: string } } }> }): Set<string> {
    const out = new Set<string>();
    for (const member of union.options ?? []) {
        const v = member.shape?.method?.value;
        if (typeof v === 'string') out.add(v);
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
    if (!JSONRPCMessageSchema.safeParse(msg).success) {
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
