import * as z from 'zod/v4';

import { IconSchema } from '../../schemas';
import { SERVER_CARD_SCHEMA_URL } from './constants';

// Hand-written port of the experimental Server Card extension's authoritative
// schema.ts (SEP-2127, repo experimental-ext-server-card). Field JSDoc is
// carried over from the extension source. Objects are open (looseObject):
// unknown fields survive parsing, and vendor data belongs in namespaced
// `_meta`. Core-spec `Icon` is reused from ../../schemas, never re-modeled.

/**
 * Version ranges are rejected at the validator level (spec prose, not
 * expressible in the generated JSON Schema): `^1.2.3`, `~1.2.3`, `>=1.2.3`,
 * `<=1`, `>1`, `<1`, `1.x`, `1.*`. Exact versions and plain non-semver
 * strings pass.
 */
function isVersionRange(version: string): boolean {
    if (/^(?:[\^~]|[<>]=?)/.test(version)) {
        return true;
    }
    return /^\d+(?:\.(?:\d+|[x*]))*$/i.test(version) && /[x*]/i.test(version);
}

/**
 * A user-supplied or pre-set input value, used for remote URL variables and
 * header values.
 */
export const ServerCardInputSchema = z.looseObject({
    /**
     * Human-readable explanation of the input. Clients can use this to
     * provide context to the user.
     */
    description: z.string().optional(),
    /**
     * Whether the input must be supplied for the connection to succeed.
     */
    isRequired: z.boolean().optional(),
    /**
     * Whether the input is a secret value (e.g., password, token). If true,
     * clients should handle the value securely.
     */
    isSecret: z.boolean().optional(),
    /**
     * Specifies the input format. `"filepath"` should be interpreted as a
     * file on the user's filesystem. When the input is converted to a string,
     * booleans should be represented by `"true"`/`"false"`, and numbers by
     * decimal values.
     */
    format: z.enum(['string', 'number', 'boolean', 'filepath']).optional(),
    /**
     * Default value for the input. SHOULD be a valid value for the input.
     */
    default: z.string().optional(),
    /**
     * Placeholder displayed during configuration to provide examples or
     * guidance about the expected form of the input.
     */
    placeholder: z.string().optional(),
    /**
     * Pre-set value for the input. If set, the value should not be
     * configurable by end users. Identifiers wrapped in `{curly_braces}` will
     * be replaced with the corresponding entries from the input's `variables`
     * map (if any).
     */
    value: z.string().optional(),
    /**
     * Allowed values for the input. If provided, the user must select one.
     */
    choices: z.array(z.string()).optional()
});

/**
 * A named input — used for HTTP headers — whose `value` may reference
 * variables for substitution.
 */
export const ServerCardKeyValueInputSchema = ServerCardInputSchema.extend({
    /**
     * Name of the header.
     */
    name: z.string(),
    /**
     * Variables referenced by `{curly_braces}` identifiers in `value`. The
     * map key is the variable name; the value defines the variable's
     * properties.
     */
    variables: z.record(z.string(), ServerCardInputSchema).optional()
});

/**
 * Metadata for connecting to a remote (HTTP-based) MCP server endpoint.
 */
export const ServerCardRemoteSchema = z.looseObject({
    /**
     * The transport type for this remote endpoint.
     */
    type: z.enum(['streamable-http', 'sse']),
    /**
     * URL template for the remote endpoint. Must start with `http://`,
     * `https://`, or a `{template_variable}`. Variables in `{curly_braces}`
     * are substituted from the `variables` map before the client connects.
     */
    url: z.string().regex(/^(https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/),
    /**
     * HTTP headers required or accepted when connecting to this remote
     * endpoint. Each header is described as a key-value input so that clients
     * can prompt users for required values, mark secrets, surface defaults,
     * and constrain to a list of choices.
     */
    headers: z.array(ServerCardKeyValueInputSchema).optional(),
    /**
     * Configuration variables that can be referenced as `{curly_braces}`
     * placeholders in `url` (and inside header values via each header's own
     * `variables`). The map key is the variable name; the value defines the
     * variable's properties.
     */
    variables: z.record(z.string(), ServerCardInputSchema).optional(),
    /**
     * MCP protocol versions actively supported by this remote endpoint.
     * Allows clients to select a compatible protocol version before
     * connecting.
     */
    supportedProtocolVersions: z.array(z.string()).optional()
});

/**
 * Repository metadata for the MCP server source code. Enables users and
 * security experts to inspect the code, improving transparency.
 */
export const ServerCardRepositorySchema = z.looseObject({
    /**
     * Repository URL for browsing source code. Should support both web
     * browsing and `git clone` operations.
     */
    url: z.url(),
    /**
     * Repository hosting service identifier (e.g., `"github"`). Used by
     * registries to determine validation and API access methods.
     */
    source: z.string(),
    /**
     * Optional relative path from repository root to the server location
     * within a monorepo or nested package structure. Must be a clean relative
     * path.
     */
    subfolder: z.string().optional(),
    /**
     * Repository identifier from the hosting service (e.g., GitHub repo ID).
     * Owned and determined by the source forge. Should remain stable across
     * repository renames and may be used to detect repository resurrection
     * attacks.
     */
    id: z.string().optional()
});

/**
 * A static metadata document describing a remote MCP server, suitable for
 * pre-connection discovery. A Server Card may be hosted at any unreserved
 * URI; MCP reserves `GET <streamable-http-url>/server-card` as the
 * recommended location.
 *
 * Card contents are advisory, never authoritative: clients MUST NOT use them
 * for security or access-control decisions, and SHOULD prefer runtime values
 * on disagreement.
 *
 * Validation is strict about the spec's constraints: a missing or wrong
 * `$schema` is rejected here. Lenient ingestion (defaulting a missing
 * `$schema`) lives in the client fetch helpers, not in this schema.
 */
export const ServerCardSchema = z.looseObject({
    /**
     * The Server Card JSON Schema URI that this document conforms to.
     * Required. Must be exactly the v1 Server Card schema URL.
     */
    $schema: z.literal(SERVER_CARD_SCHEMA_URL),
    /**
     * Server name in reverse-DNS format. Must contain exactly one forward
     * slash separating namespace from server name.
     */
    name: z
        .string()
        .min(3)
        .max(200)
        .regex(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/),
    /**
     * Version string for this server. SHOULD follow semantic versioning
     * (e.g., '1.0.2', '2.1.0-alpha'). Equivalent of `Implementation.version`.
     * Non-semantic versions are allowed but may not sort predictably.
     * Version ranges are rejected (e.g., '^1.2.3', '~1.2.3', '>=1.2.3',
     * '1.x', '1.*').
     */
    version: z
        .string()
        .max(255)
        .refine(version => !isVersionRange(version), {
            message: 'version must be an exact version, not a range (e.g. ^1.2.3, ~1.2.3, >=1.2.3, 1.x, 1.*)'
        }),
    /**
     * Clear human-readable explanation of server functionality. Should focus
     * on capabilities, not implementation details.
     */
    description: z.string().min(1).max(100),
    /**
     * Optional human-readable title or display name for the MCP server.
     */
    title: z.string().min(1).max(100).optional(),
    /**
     * Optional URL to the server's homepage, documentation, or project
     * website.
     */
    websiteUrl: z.url().optional(),
    /**
     * Optional repository metadata for the MCP server source code.
     */
    repository: ServerCardRepositorySchema.optional(),
    /**
     * Optional set of sized icons that the client can display in a user
     * interface. Clients that render icons MUST support `image/png` and
     * `image/jpeg`, and SHOULD support `image/svg+xml` and `image/webp`.
     */
    icons: z.array(IconSchema).optional(),
    /**
     * Metadata helpful for making HTTP-based connections to this MCP server.
     */
    remotes: z.array(ServerCardRemoteSchema).optional(),
    /**
     * Extension metadata using reverse-DNS namespacing for vendor-specific
     * data. Follows the protocol's standard `_meta` definition.
     */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/** A validated Server Card document. Advisory data; see `ServerCardSchema`. */
export type ServerCard = z.infer<typeof ServerCardSchema>;
/** A user-supplied or pre-set input value declared by a card remote. */
export type ServerCardInput = z.infer<typeof ServerCardInputSchema>;
/** A named header input declared by a card remote. */
export type ServerCardKeyValueInput = z.infer<typeof ServerCardKeyValueInputSchema>;
/** Connection metadata for one remote endpoint declared by a card. */
export type ServerCardRemote = z.infer<typeof ServerCardRemoteSchema>;
/** Source repository metadata declared by a card. */
export type ServerCardRepository = z.infer<typeof ServerCardRepositorySchema>;
