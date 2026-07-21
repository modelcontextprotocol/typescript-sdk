import * as z from 'zod/v4';

// AI Catalog schemas (external Agent-Card spec, https://ai-catalog.io/spec/).
// Modeled only as deep as Server Card discovery needs: entry identity, the
// url/data carrier, and display metadata. Host, publisher, and trust-manifest
// shapes stay loose records so catalog-spec churn cannot break parsing.

/**
 * One entry in an AI Catalog. For MCP Server Card discovery the relevant
 * entries have `type: 'application/mcp-server-card+json'` and carry the card
 * either by `url` (fetch it there) or inline as `data` — exactly one of the
 * two.
 *
 * `identifier`, `publisher`, and `trustManifest` are self-asserted by the
 * catalog publisher and unverified.
 */
export const AICatalogEntrySchema = z
    .looseObject({
        /**
         * Unique identifier for the entry. The recommended form is the
         * domain-anchored URN `urn:air:{publisher}:{namespace}:{name}`, e.g.
         * `urn:air:example.com:mcp:weather`.
         */
        identifier: z.string(),
        /**
         * Media type of the referenced artifact, e.g.
         * `application/mcp-server-card+json`.
         */
        type: z.string(),
        /**
         * URL where the artifact can be fetched. Exactly one of `url` or
         * `data` must be present.
         */
        url: z.string().optional(),
        /**
         * Inline artifact content. Exactly one of `url` or `data` must be
         * present.
         */
        data: z.unknown().optional(),
        /**
         * Display name for the entry. Takes precedence over the artifact's
         * internal name for display purposes.
         */
        displayName: z.string().optional(),
        /**
         * Human-readable description of the entry.
         */
        description: z.string().optional(),
        /**
         * Version of the referenced artifact.
         */
        version: z.string().optional(),
        /**
         * ISO 8601 timestamp of the entry's last update.
         */
        updatedAt: z.string().optional(),
        /**
         * Free-form tags for the entry.
         */
        tags: z.array(z.string()).optional(),
        /**
         * Self-asserted publisher identity for the entry.
         */
        publisher: z
            .looseObject({
                identifier: z.string().optional(),
                displayName: z.string().optional()
            })
            .optional(),
        /**
         * Self-asserted trust manifest (publisher identity, attestations,
         * provenance). Kept loose; verification is host policy.
         */
        trustManifest: z.record(z.string(), z.unknown()).optional(),
        /**
         * Extension metadata, keys reverse-DNS prefixed.
         */
        metadata: z.record(z.string(), z.unknown()).optional()
    })
    .refine(entry => (entry.url !== undefined) !== (entry.data !== undefined), {
        message: 'an AI Catalog entry must carry exactly one of `url` or `data`'
    });

/**
 * Information about the host publishing an AI Catalog.
 */
export const AICatalogHostSchema = z.looseObject({
    /**
     * Display name of the catalog host.
     */
    displayName: z.string(),
    /**
     * Identifier of the catalog host.
     */
    identifier: z.string().optional(),
    /**
     * Documentation URL for the catalog host.
     */
    documentationUrl: z.string().optional(),
    /**
     * Logo URL for the catalog host.
     */
    logoUrl: z.string().optional(),
    /**
     * Self-asserted trust manifest for the host. Kept loose.
     */
    trustManifest: z.record(z.string(), z.unknown()).optional()
});

/**
 * An AI Catalog document, typically published at
 * `/.well-known/ai-catalog.json`, advertising AI artifacts including MCP
 * Server Cards.
 */
export const AICatalogSchema = z.looseObject({
    /**
     * Catalog spec version in `Major.Minor` form, e.g. `"1.0"`.
     */
    specVersion: z.string(),
    /**
     * Catalog entries. May be empty.
     */
    entries: z.array(AICatalogEntrySchema),
    /**
     * Information about the publishing host.
     */
    host: AICatalogHostSchema.optional(),
    /**
     * Extension metadata, keys reverse-DNS prefixed.
     */
    metadata: z.record(z.string(), z.unknown()).optional()
});

/** A validated AI Catalog document. */
export type AICatalog = z.infer<typeof AICatalogSchema>;
/** One validated AI Catalog entry. Self-asserted, unverified data. */
export type AICatalogEntry = z.infer<typeof AICatalogEntrySchema>;
/** Validated host information from an AI Catalog. */
export type AICatalogHost = z.infer<typeof AICatalogHostSchema>;
