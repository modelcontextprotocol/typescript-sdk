/**
 * Static era pins for lifecycle messages on the OUTBOUND path (the
 * chicken-and-egg bootstrap): these messages are sent before any negotiated
 * version exists, and they self-identify their era by construction —
 * `initialize`/`notifications/initialized` ARE the legacy handshake (Q2:
 * `initialize` ⇒ legacy), and `server/discover` exists only on the 2026 era.
 * No negotiated-state guess ever picks a payload schema for them.
 *
 * Scope notes:
 * - OUTBOUND ONLY. Inbound era truth is per-request classification (Q2) with
 *   session state as fallback — pinning inbound would override the
 *   classifier (an unclassified `server/discover` request classifies legacy
 *   and correctly falls to −32601 by registry absence).
 * - `ping` is deliberately NOT pinned. A bare `{method: 'ping'}` carries no
 *   era marker — under Q2 it classifies legacy by DEFAULT, not by
 *   self-identification — and pinning it would let a negotiated-modern
 *   session emit a 2025-only method onto the modern leg (the exact inverse
 *   leak registry membership exists to prevent). `ping` era-gates like any
 *   other method: present on the 2025 era, absent from the 2026 era (the
 *   modern keepalive story is owned by the negotiation milestones).
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
