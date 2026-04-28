import type { AuthInfo } from '@modelcontextprotocol/server';

// Re-exported for backwards compatibility; canonical home is @modelcontextprotocol/server.
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
