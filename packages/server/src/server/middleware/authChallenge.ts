/**
 * Shared `WWW-Authenticate` challenge-header construction for the SDK's OAuth resource-server
 * gates (`bearerAuth.ts`, `dpopAuth.ts`). Internal — not part of the public API surface; each gate
 * exports its own scheme-specific wrapper around {@linkcode buildWwwAuthenticateHeader}.
 */

/**
 * HTTP quoted-string encoding per RFC 7235: escape backslash and double quote, and replace
 * characters a header cannot carry (controls, anything beyond printable ASCII) so a
 * verifier-authored message can never make the challenge `Response` constructor throw.
 */
export function headerQuotedValue(value: string): string {
    return value.replaceAll(/[\\"]/g, String.raw`\$&`).replaceAll(/[^ -~]/g, ' ');
}

/**
 * Build a `WWW-Authenticate` challenge header for `scheme` (`Bearer` or `DPoP`), with the standard
 * `error`/`error_description`/`scope`/`resource_metadata` parameters plus any scheme-specific ones
 * (e.g. DPoP's `algs`), in that order.
 */
export function buildWwwAuthenticateHeader(
    scheme: string,
    errorCode: string,
    description: string,
    requiredScopes: string[],
    resourceMetadataUrl: string | undefined,
    extraParams?: Record<string, string>
): string {
    let header = `${scheme} error="${headerQuotedValue(errorCode)}", error_description="${headerQuotedValue(description)}"`;
    if (requiredScopes.length > 0) {
        header += `, scope="${requiredScopes.join(' ')}"`;
    }
    if (resourceMetadataUrl) {
        header += `, resource_metadata="${resourceMetadataUrl}"`;
    }
    if (extraParams) {
        for (const [key, value] of Object.entries(extraParams)) {
            header += `, ${key}="${headerQuotedValue(value)}"`;
        }
    }
    return header;
}
