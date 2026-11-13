import type { OAuthClientMetadata } from '@modelcontextprotocol/client';
import { DpopSession } from '@modelcontextprotocol/client';

import { ConformanceOAuthProvider } from './conformanceOAuthProvider';

/**
 * {@linkcode ConformanceOAuthProvider} plus a DPoP signing session (SEP-1932 / RFC 9449).
 *
 * Adding `dpop()` is the *only* thing this class does — every DPoP-specific behavior (a proof at
 * the token endpoint, presenting the token with the `DPoP` scheme, a fresh proof per MCP request,
 * retrying on an AS/RS `use_dpop_nonce` challenge) lives in `@modelcontextprotocol/client` itself
 * (`dpop.ts` / `auth.ts` / `streamableHttp.ts`) and is exercised end-to-end through this provider,
 * not re-implemented here. The same handler drives both the `auth/dpop` (nonce-less) and
 * `auth/dpop-nonce` postures — which one is exercised depends entirely on whether the test
 * authorization server / MCP server issue a `use_dpop_nonce` challenge, which the SDK reacts to
 * automatically.
 */
export class DpopOAuthProvider extends ConformanceOAuthProvider {
    private readonly _dpopSession: Promise<DpopSession>;

    constructor(redirectUrl: string | URL, clientMetadata: OAuthClientMetadata, clientMetadataUrl?: string | URL) {
        super(redirectUrl, clientMetadata, clientMetadataUrl);
        this._dpopSession = DpopSession.create();
    }

    async dpop(): Promise<DpopSession> {
        return this._dpopSession;
    }
}
