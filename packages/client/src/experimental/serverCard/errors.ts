import type { ServerCardInput } from '@modelcontextprotocol/core/experimental/server-card';

/**
 * Error codes for the Server Card discovery helpers.
 */
export type ServerCardErrorCode =
    /** A discovery URL string could not be parsed as a URL (`cause` is the TypeError). */
    | 'invalid-url'
    /** URL guard rejection (scheme or address class), on any redirect hop. */
    | 'blocked-host'
    /**
     * The transport failed before an HTTP response arrived (DNS failure,
     * TLS error, connection reset). `cause` is the underlying thrown error.
     */
    | 'network-error'
    /** Non-2xx, non-304 HTTP status. */
    | 'http-error'
    /** Content-Type essence is not an acceptable media type. */
    | 'invalid-media-type'
    /** Response body exceeded `maxResponseBytes`. */
    | 'response-too-large'
    /** Redirect chain exceeded `maxRedirects`. */
    | 'too-many-redirects'
    /**
     * A Server Card document failed validation. `cause` is the ZodError, or
     * the SyntaxError when the response body is not JSON at all.
     */
    | 'invalid-server-card'
    /**
     * An AI Catalog document failed validation. `cause` is the ZodError, or
     * the SyntaxError when the response body is not JSON at all.
     */
    | 'invalid-ai-catalog'
    /** `resolveRemote`: a required input was not supplied. */
    | 'missing-input'
    /** `resolveRemote`: a choices violation, or the resolved URL is not http(s). */
    | 'invalid-input';

/**
 * Error thrown by the Server Card discovery and resolution helpers. The
 * `code` identifies the failure class; `url`, `status`, `mediaType`, and
 * `missing` carry the structured detail relevant to that class.
 */
export class ServerCardError extends Error {
    /** The failure class. */
    readonly code: ServerCardErrorCode;
    /** The offending URL (final hop), when the failure has one. */
    readonly url?: string;
    /** The HTTP status, for `'http-error'`. */
    readonly status?: number;
    /** The offending media type essence, for `'invalid-media-type'`. */
    readonly mediaType?: string;
    /**
     * Every unmet required input, for `'missing-input'`. Aggregated so a
     * host can prompt for all of them in one round trip.
     */
    readonly missing?: ReadonlyArray<{ key: string; input: ServerCardInput }>;

    constructor(
        code: ServerCardErrorCode,
        message: string,
        options?: {
            url?: string;
            status?: number;
            mediaType?: string;
            missing?: ReadonlyArray<{ key: string; input: ServerCardInput }>;
            cause?: unknown;
        }
    ) {
        super(message, options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'ServerCardError';
        this.code = code;
        this.url = options?.url;
        this.status = options?.status;
        this.mediaType = options?.mediaType;
        this.missing = options?.missing;
    }
}
