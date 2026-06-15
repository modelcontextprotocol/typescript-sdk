/**
 * 2026-era wire schemas (protocol revision 2026-07-28).
 *
 * This module is the only place the per-request `_meta` envelope is modeled.
 * The envelope is wire-only vocabulary: the protocol layer lifts it off
 * inbound requests before any handler runs and surfaces it at
 * `ctx.mcpReq.envelope`; the 2026-era codec enforces its requiredness at
 * dispatch time (`checkInboundEnvelope`) - the former neutral-schema JSDoc
 * deferral ("enforced per request at dispatch time, not here") is now
 * discharged by that codec step.
 *
 * No 2025-era traffic ever touches this module, so requiredness here is
 * bare and spec-exact (the shared-schema `.catch` hazards do not apply).
 */
import * as z from 'zod/v4';

import {
    CLIENT_CAPABILITIES_META_KEY,
    CLIENT_INFO_META_KEY,
    LOG_LEVEL_META_KEY,
    PROTOCOL_VERSION_META_KEY
} from '../../types/constants.js';
import { ClientCapabilitiesSchema, ImplementationSchema, LoggingLevelSchema, ProgressTokenSchema } from '../../types/schemas.js';

/* Per-request `_meta` envelope */
/**
 * The per-request `_meta` envelope carried by every request under protocol revision
 * 2026-07-28: the protocol version governing the request, the client implementation
 * info, and the client's capabilities — declared per request rather than once at
 * initialization — plus the optional log-level opt-in.
 *
 * This schema models the complete envelope on its own (loose: foreign keys
 * pass through - the lift extracts exactly the reserved keys, so enforcement
 * never sees extension material). Requiredness is enforced per request at
 * dispatch time by the 2026-era codec's `checkInboundEnvelope` step.
 */
export const RequestMetaEnvelopeSchema = z.looseObject({
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: ProgressTokenSchema.optional(),
    /**
     * The MCP protocol version being used for this request. For the HTTP transport,
     * the value must match the `MCP-Protocol-Version` header.
     */
    [PROTOCOL_VERSION_META_KEY]: z.string(),
    /**
     * Identifies the client software making the request.
     */
    [CLIENT_INFO_META_KEY]: ImplementationSchema,
    /**
     * The client's capabilities for this specific request. An empty object means the
     * client supports no optional capabilities. Servers must not infer capabilities
     * from prior requests.
     */
    [CLIENT_CAPABILITIES_META_KEY]: ClientCapabilitiesSchema,
    /**
     * The desired log level for this request. When absent, the server must not send
     * `notifications/message` notifications for the request.
     *
     * @deprecated Deprecated as of protocol version 2026-07-28 (SEP-2577); remains
     * in the specification for at least twelve months.
     */
    [LOG_LEVEL_META_KEY]: LoggingLevelSchema.optional()
});
