/**
 * MCP Server Cards — experimental implementation of SEP-2127.
 *
 * A Server Card is a static metadata document describing a remote MCP server,
 * suitable for publishing at a `.well-known/mcp-server-card` URI for
 * pre-connection discovery. It tells a client who the server is, where to
 * connect, and which protocol versions are supported — without requiring the
 * client to initialize a session first.
 *
 * This module is the schema source of truth shared by the server-side
 * publishing helpers and the client-side reading helpers. Both validate
 * documents against {@link ServerCardSchema} so malformed cards are caught
 * before they are served or consumed.
 *
 * WARNING: These APIs are experimental and may change without notice, tracking
 * SEP-2127. When Server Cards graduate, these types are expected to move into
 * the stable type surface.
 *
 * @see https://github.com/modelcontextprotocol/experimental-ext-server-card
 * @see https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127
 * @experimental
 * @module
 */

import * as z from 'zod/v4';

import { IconSchema } from '../types/schemas.js';

/**
 * The well-known path at which a Server Card is published, relative to the
 * server's origin (e.g. `https://example.com/.well-known/mcp-server-card`).
 *
 * @experimental
 */
export const SERVER_CARD_WELL_KNOWN_PATH = '/.well-known/mcp-server-card';

/**
 * Canonical `$schema` URL for a Server Card document.
 *
 * @experimental
 */
export const SERVER_CARD_SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json';

/**
 * Canonical `$schema` URL for a `server.json` document (the {@link ServerJson}
 * superset used by registries).
 *
 * @experimental
 */
export const SERVER_JSON_SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/v1/server.schema.json';

/**
 * Permitted shape for a Server Card / `server.json` `$schema` value. Schema
 * URLs are versioned by the `vN` segment rather than by date.
 */
const SCHEMA_URL_PATTERN = /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/v1\/[^/]+\.schema\.json$/;

/** Server name in reverse-DNS format: `namespace/name`. */
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;

/**
 * URL template: an absolute `http(s)` URL or a `{template-variable}` followed
 * by additional path/query. Used by remote and package transport URLs.
 */
const URL_TEMPLATE_PATTERN = /^(https?:\/\/[^\s]+|\{[a-zA-Z_][a-zA-Z0-9_]*\}[^\s]*)$/;

/** SHA-256 hash, lowercase hex. */
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** Rejects version ranges (e.g. `^1.2.3`, `~1.2.3`, `>=1.2.3`, `1.x`, `1.*`). */
const VERSION_RANGE_PATTERN = /[\^~]|^[<>]=?|(?:^|\.)[xX*](?:$|\.)/;

/** A URL-template string field: an http(s) URL, or a `{template-variable}` placeholder. */
const urlTemplate = (): z.ZodString => z.string().regex(URL_TEMPLATE_PATTERN, 'Must be an http(s) URL or start with a {template-variable}');

/**
 * A user-supplied or pre-set input value, used in {@link Package} argument and
 * environment-variable definitions, and in {@link Remote} variable maps.
 *
 * @experimental
 */
export const InputSchema = z.object({
    /** Human-readable explanation of the input, shown to the user for context. */
    description: z.string().optional(),
    /** Whether the input must be supplied for the package to run. */
    isRequired: z.boolean().optional(),
    /** Whether the input is a secret value (e.g. password, token). */
    isSecret: z.boolean().optional(),
    /** Input format. `"filepath"` should be interpreted as a file on the user's filesystem. */
    format: z.enum(['string', 'number', 'boolean', 'filepath']).optional(),
    /** Default value for the input. */
    default: z.string().optional(),
    /** Placeholder shown during configuration to illustrate the expected form. */
    placeholder: z.string().optional(),
    /**
     * Pre-set value. If set, the value should not be configurable by end users.
     * `{curly_brace}` identifiers are replaced from the input's `variables` map.
     */
    value: z.string().optional(),
    /** Allowed values. If provided, the user must select one. */
    choices: z.array(z.string()).optional()
});

/**
 * An {@link Input} whose `value` may reference variables for substitution.
 *
 * @experimental
 */
export const InputWithVariablesSchema = InputSchema.extend({
    /**
     * Variables referenced by `{curly_braces}` identifiers in `value`. The map
     * key is the variable name; the value defines the variable's properties.
     */
    variables: z.record(z.string(), InputSchema).optional()
});

/**
 * A named input — used for environment variables and HTTP headers.
 *
 * @experimental
 */
export const KeyValueInputSchema = InputWithVariablesSchema.extend({
    /** Name of the header or environment variable. */
    name: z.string()
});

/**
 * A positional command-line input — a value inserted verbatim into the command line.
 *
 * @experimental
 */
export const PositionalArgumentSchema = InputWithVariablesSchema.extend({
    type: z.literal('positional'),
    /** Identifier for the positional argument, used as a label and for URL variable substitution. */
    valueHint: z.string().optional(),
    /** Whether the argument can be repeated multiple times in the command line. */
    isRepeated: z.boolean().optional()
});

/**
 * A named command-line input — a `--flag={value}` parameter.
 *
 * @experimental
 */
export const NamedArgumentSchema = InputWithVariablesSchema.extend({
    type: z.literal('named'),
    /** The flag name, including any leading dashes (e.g. `"--port"`). */
    name: z.string(),
    /** Whether the argument can be repeated multiple times. */
    isRepeated: z.boolean().optional()
});

/**
 * A command-line argument supplied to a package's binary or runtime.
 *
 * @experimental
 */
export const ArgumentSchema = z.discriminatedUnion('type', [PositionalArgumentSchema, NamedArgumentSchema]);

/**
 * Repository metadata for the MCP server source code. Enables users and
 * security experts to inspect the code, improving transparency.
 *
 * @experimental
 */
export const RepositorySchema = z.object({
    /** Repository URL for browsing source code and running `git clone`. */
    url: z.string().url(),
    /** Repository hosting service identifier (e.g. `"github"`). */
    source: z.string(),
    /** Optional relative path from repository root to the server within a monorepo. */
    subfolder: z.string().optional(),
    /** Repository identifier from the hosting service (e.g. GitHub repo ID). */
    id: z.string().optional()
});

/**
 * Metadata for connecting to a remote (HTTP-based) MCP server endpoint.
 *
 * @experimental
 */
export const RemoteSchema = z.object({
    /** The transport type for this remote endpoint. */
    type: z.enum(['streamable-http', 'sse']),
    /**
     * URL template for the remote endpoint. Must start with `http://`,
     * `https://`, or a `{template-variable}`. Variables in `{curly_braces}` are
     * substituted from {@link Remote.variables} before the client connects.
     */
    url: urlTemplate(),
    /** HTTP headers required or accepted when connecting to this remote endpoint. */
    headers: z.array(KeyValueInputSchema).optional(),
    /** Configuration variables referenced as `{curly_braces}` placeholders in `url` and header values. */
    variables: z.record(z.string(), InputSchema).optional(),
    /** MCP protocol versions actively supported by this remote endpoint. */
    supportedProtocolVersions: z.array(z.string()).optional()
});

/** Stdio transport — the client launches the package as a subprocess. */
export const StdioTransportSchema = z.object({
    type: z.literal('stdio')
});

/** Shared shape for the HTTP-based package transports — identical apart from `type`. */
const HttpPackageTransportBase = z.object({
    /** URL template for the transport endpoint. */
    url: urlTemplate(),
    /** HTTP headers to include when connecting to the package's local endpoint. */
    headers: z.array(KeyValueInputSchema).optional()
});

/** Streamable-HTTP transport for a locally-runnable package. */
export const StreamableHttpPackageTransportSchema = HttpPackageTransportBase.extend({
    type: z.literal('streamable-http')
});

/** Server-sent events (SSE) transport for a locally-runnable package. */
export const SsePackageTransportSchema = HttpPackageTransportBase.extend({
    type: z.literal('sse')
});

/**
 * Transport protocol configuration for a locally-runnable package.
 *
 * @experimental
 */
export const PackageTransportSchema = z.discriminatedUnion('type', [
    StdioTransportSchema,
    StreamableHttpPackageTransportSchema,
    SsePackageTransportSchema
]);

/**
 * Metadata for installing and running a packaged MCP server locally.
 *
 * @experimental
 */
export const PackageSchema = z.object({
    /** Registry type indicating how to download packages (e.g. `"npm"`, `"pypi"`, `"oci"`). */
    registryType: z.string(),
    /** Package identifier — a package name (for registries) or a URL (for direct downloads). */
    identifier: z.string(),
    /** Transport configuration for invoking this package after installation. */
    transport: PackageTransportSchema,
    /** Base URL of the package registry. */
    registryBaseUrl: z.string().url().optional(),
    /** Package version. */
    version: z.string().min(1).optional(),
    /** MCP protocol versions actively supported by this package. */
    supportedProtocolVersions: z.array(z.string()).optional(),
    /** A hint to help clients determine the appropriate runtime (e.g. `"npx"`, `"uvx"`, `"docker"`). */
    runtimeHint: z.string().optional(),
    /** Arguments passed to the package's runtime command (such as `docker` or `npx`). */
    runtimeArguments: z.array(ArgumentSchema).optional(),
    /** Arguments passed to the package's binary. */
    packageArguments: z.array(ArgumentSchema).optional(),
    /** Environment variables to be set when running the package. */
    environmentVariables: z.array(KeyValueInputSchema).optional(),
    /** SHA-256 hash of the package file for integrity verification. */
    fileSha256: z.string().regex(SHA256_PATTERN, 'Must be a lowercase hex SHA-256 hash').optional()
});

/**
 * A static metadata document describing a remote MCP server, suitable for
 * publishing at a {@link SERVER_CARD_WELL_KNOWN_PATH} URI for pre-connection
 * discovery.
 *
 * Server Cards intentionally describe only what is needed to discover and
 * connect to a remote server: identity, transport, and protocol versions. They
 * do not enumerate primitives (tools, resources, prompts) — those remain
 * subject to runtime listing via the protocol's standard list operations.
 *
 * @experimental
 */
export const ServerCardSchema = z.object({
    /**
     * The Server Card JSON Schema URI that this document conforms to. Must be a
     * `/v1/` URL under `static.modelcontextprotocol.io/schemas/`.
     */
    $schema: z.string().regex(SCHEMA_URL_PATTERN, 'Must be a versioned static.modelcontextprotocol.io v1 schema URL'),
    /** Server name in reverse-DNS format, with exactly one `/` separating namespace from name. */
    name: z.string().min(3).max(200).regex(SERVER_NAME_PATTERN, 'Must be `namespace/name` in reverse-DNS format'),
    /**
     * Version string for this server. SHOULD follow semantic versioning.
     * Version ranges (e.g. `^1.2.3`, `1.x`) are rejected.
     */
    version: z
        .string()
        .min(1)
        .max(255)
        .refine(value => !VERSION_RANGE_PATTERN.test(value), 'Version ranges are not allowed; provide a concrete version'),
    /** Clear human-readable explanation of server functionality. */
    description: z.string().min(1).max(100),
    /** Optional human-readable title or display name for the MCP server. */
    title: z.string().min(1).max(100).optional(),
    /** Optional URL to the server's homepage, documentation, or project website. */
    websiteUrl: z.string().url().optional(),
    /** Optional repository metadata for the MCP server source code. */
    repository: RepositorySchema.optional(),
    /** Optional set of sized icons that the client can display in a user interface. */
    icons: z.array(IconSchema).optional(),
    /** Metadata helpful for making HTTP-based connections to this MCP server. */
    remotes: z.array(RemoteSchema).optional(),
    /** Extension metadata using reverse-DNS namespacing for vendor-specific data. */
    _meta: z.record(z.string(), z.unknown()).optional()
});

/**
 * A superset of {@link ServerCard} that additionally describes locally-runnable
 * packages. This is the shape used by the MCP Registry's `server.json`.
 *
 * Corresponds to the SEP-2127 `Server` type; renamed `ServerJson` here to avoid
 * colliding with the `Server` protocol class exported by `@modelcontextprotocol/server`.
 *
 * @experimental
 */
export const ServerJsonSchema = ServerCardSchema.extend({
    /** Metadata helpful for running and connecting to local instances of this MCP server. */
    packages: z.array(PackageSchema).optional()
});

/**
 * A user-supplied or pre-set input value, used in {@link Package} argument and
 * environment-variable definitions, and in {@link Remote} variable maps.
 *
 * @experimental
 */
export type Input = z.infer<typeof InputSchema>;

/**
 * An {@link Input} whose `value` may reference variables for substitution.
 *
 * @experimental
 */
export type InputWithVariables = z.infer<typeof InputWithVariablesSchema>;

/**
 * A named input — used for environment variables and HTTP headers.
 *
 * @experimental
 */
export type KeyValueInput = z.infer<typeof KeyValueInputSchema>;

/**
 * A positional command-line input — a value inserted verbatim into the command line.
 *
 * @experimental
 */
export type PositionalArgument = z.infer<typeof PositionalArgumentSchema>;

/**
 * A named command-line input — a `--flag={value}` parameter.
 *
 * @experimental
 */
export type NamedArgument = z.infer<typeof NamedArgumentSchema>;

/**
 * A command-line argument supplied to a package's binary or runtime.
 *
 * @experimental
 */
export type Argument = z.infer<typeof ArgumentSchema>;

/**
 * Repository metadata for the MCP server source code.
 *
 * @experimental
 */
export type Repository = z.infer<typeof RepositorySchema>;

/**
 * Metadata for connecting to a remote (HTTP-based) MCP server endpoint.
 *
 * @experimental
 */
export type Remote = z.infer<typeof RemoteSchema>;

/**
 * Stdio transport for a locally-runnable package.
 *
 * @experimental
 */
export type StdioTransport = z.infer<typeof StdioTransportSchema>;

/**
 * Streamable-HTTP transport for a locally-runnable package.
 *
 * @experimental
 */
export type StreamableHttpPackageTransport = z.infer<typeof StreamableHttpPackageTransportSchema>;

/**
 * Server-sent events (SSE) transport for a locally-runnable package.
 *
 * @experimental
 */
export type SsePackageTransport = z.infer<typeof SsePackageTransportSchema>;

/**
 * Transport protocol configuration for a locally-runnable package.
 *
 * @experimental
 */
export type PackageTransport = z.infer<typeof PackageTransportSchema>;

/**
 * Metadata for installing and running a packaged MCP server locally.
 *
 * @experimental
 */
export type Package = z.infer<typeof PackageSchema>;

/**
 * A static metadata document describing a remote MCP server, served at the
 * {@link SERVER_CARD_WELL_KNOWN_PATH} URI for pre-connection discovery.
 *
 * @experimental
 */
export type ServerCard = z.infer<typeof ServerCardSchema>;

/**
 * A superset of {@link ServerCard} that additionally describes locally-runnable
 * packages — the shape used by the MCP Registry's `server.json`.
 *
 * @experimental
 */
export type ServerJson = z.infer<typeof ServerJsonSchema>;

/**
 * Parses and validates an unknown value as a {@link ServerCard}.
 *
 * @throws {z.ZodError} if the value is not a valid Server Card.
 * @experimental
 */
export function parseServerCard(data: unknown): ServerCard {
    return ServerCardSchema.parse(data);
}

/**
 * Safely parses an unknown value as a {@link ServerCard}, returning a Zod
 * result object instead of throwing.
 *
 * @experimental
 */
export function safeParseServerCard(data: unknown): { success: true; data: ServerCard } | { success: false; error: z.core.$ZodError } {
    return ServerCardSchema.safeParse(data);
}

/**
 * Parses and validates an unknown value as a {@link ServerJson} document.
 *
 * @throws {z.ZodError} if the value is not a valid `server.json` document.
 * @experimental
 */
export function parseServerJson(data: unknown): ServerJson {
    return ServerJsonSchema.parse(data);
}

/**
 * Safely parses an unknown value as a {@link ServerJson} document, returning a
 * Zod result object instead of throwing.
 *
 * @experimental
 */
export function safeParseServerJson(data: unknown): { success: true; data: ServerJson } | { success: false; error: z.core.$ZodError } {
    return ServerJsonSchema.safeParse(data);
}
