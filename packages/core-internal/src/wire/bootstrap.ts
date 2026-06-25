/**
 * Static era pins for lifecycle messages on the OUTBOUND path (the
 * chicken-and-egg bootstrap): these messages are sent while the instance's
 * negotiated protocol version is still unset, and they self-identify their
 * era by construction — `initialize`/`notifications/initialized` ARE the
 * legacy handshake (`initialize` ⇒ legacy), and `server/discover` exists only
 * on the 2026 era. The pins apply only during that pre-negotiation window
 * (`Protocol._resolveOutboundCodec` consults them when the negotiated version
 * is `undefined`); once a version is negotiated, every send resolves through
 * the instance's era.
 *
 * Scope notes:
 * - OUTBOUND ONLY. Inbound era truth is the instance's negotiated protocol
 *   version (connection state); an edge classification, when present, is
 *   VALIDATED against that instance era — never used to pick a codec per
 *   message — so pinning inbound would have nothing to attach to. An
 *   inbound `server/discover` on a legacy-era instance correctly falls to
 *   −32601 by registry absence; serving it requires an instance bound to
 *   the modern era.
 * - `ping` is deliberately NOT pinned. A bare `{method: 'ping'}` carries no
 *   era marker, and pinning it would let a negotiated-modern session emit a
 *   2025-only method onto the modern leg (the exact inverse leak registry
 *   membership exists to prevent). `ping` era-gates like any other method:
 *   present on the 2025 era, absent from the 2026 era (the modern keepalive
 *   story is owned by the negotiation milestones).
 */
import type { WireCodec } from './codec.js';
import { codecForVersion, MODERN_WIRE_REVISION } from './codec.js';

export function bootstrapOutboundCodec(method: string): WireCodec | undefined {
    switch (method) {
        case 'initialize':
        case 'notifications/initialized': {
            // The legacy handshake, by definition (Q2).
            return codecForVersion(undefined);
        }
        case 'server/discover': {
            // The modern discovery exchange, 2026-era only.
            return codecForVersion(MODERN_WIRE_REVISION);
        }
        default: {
            return undefined;
        }
    }
}
