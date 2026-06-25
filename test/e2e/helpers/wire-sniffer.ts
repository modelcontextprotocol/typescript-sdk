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
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    isSpecType
} from '@modelcontextprotocol/server';

export type WireParty = 'client' | 'server';

export interface SnifferOptions {
    /** Permit non-spec (vendor-extension) method names. Spec methods stay strict. */
    allowCustomMethods?: boolean;
    /** `false` → envelope check only (for tests that deliberately send malformed messages). */
    strictValidation?: boolean;
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
