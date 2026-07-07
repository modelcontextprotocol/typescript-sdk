import * as z from 'zod/v4';

/**
 * Base schema for list changed subscription options (without callback).
 * Used internally for Zod validation of `autoRefresh` and `debounceMs`.
 *
 * Lives outside `schemas.ts` deliberately: it is an SDK option schema, not a spec
 * schema, so it is not part of `@modelcontextprotocol/core`'s public surface —
 * and `schemas.ts` is resolved from that package at runtime by the client/server
 * bundles, which can only see the names core actually exports.
 */
export const ListChangedOptionsBaseSchema = z.object({
    /**
     * If `true`, the list will be refreshed automatically when a list changed notification is received.
     * The callback will be called with the updated list.
     *
     * If `false`, the callback will be called with `null` items, allowing manual refresh.
     *
     * @default true
     */
    autoRefresh: z.boolean().default(true),
    /**
     * Debounce time in milliseconds for list changed notification processing.
     *
     * Multiple notifications received within this timeframe will only trigger one refresh.
     * Set to `0` to disable debouncing.
     *
     * @default 300
     */
    debounceMs: z.number().int().nonnegative().default(300)
});
