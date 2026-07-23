import type { AuthInfo } from '@modelcontextprotocol/server';

/**
 * Re-exported from `@modelcontextprotocol/server`, where the runtime-neutral
 * Bearer authentication core lives — implement it once and use it with this
 * package's Express middleware or with `requireBearerAuth` from the server
 * package on web-standard hosts.
 */
export type { OAuthTokenVerifier } from '@modelcontextprotocol/server';

declare module 'express-serve-static-core' {
    interface Request {
        /**
         * Information about the validated access token, populated by
         * `requireBearerAuth`.
         */
        auth?: AuthInfo;
    }
}
