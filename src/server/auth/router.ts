import express, { RequestHandler } from "express";
import { clientRegistrationHandler, ClientRegistrationHandlerOptions } from "./handlers/register.js";
import { tokenHandler, TokenHandlerOptions } from "./handlers/token.js";
import { authorizationHandler, AuthorizationHandlerOptions } from "./handlers/authorize.js";
import { revocationHandler, RevocationHandlerOptions } from "./handlers/revoke.js";
import { metadataHandler } from "./handlers/metadata.js";
import { OAuthServerProvider } from "./provider.js";
import { OAuthMetadata, OAuthProtectedResourceMetadata } from "../../shared/auth.js";

export type AuthRouterOptions = {
  /**
   * A provider implementing the actual authorization logic for this router.
   */
  provider: OAuthServerProvider;

  /**
   * The authorization server's issuer identifier, which is a URL that uses the "https" scheme and has no query or fragment components.
   */
  issuerUrl: URL;

  /**
   * The base URL of the authorization server to use for the metadata endpoints.
   *
   * If not provided, the issuer URL will be used as the base URL.
   */
  baseUrl?: URL;

  /**
   * An optional URL of a page containing human-readable information that developers might want or need to know when using the authorization server.
   */
  serviceDocumentationUrl?: URL;

  /**
   * An optional list of scopes supported by this authorization server
   */
  scopesSupported?: string[];

  // Individual options per route
  authorizationOptions?: Omit<AuthorizationHandlerOptions, "provider">;
  clientRegistrationOptions?: Omit<ClientRegistrationHandlerOptions, "clientsStore">;
  revocationOptions?: Omit<RevocationHandlerOptions, "provider">;
  tokenOptions?: Omit<TokenHandlerOptions, "provider">;
  protectedResourceOptions?: Omit<ProtectedResourceRouterOptions, "issuerUrl" | "serviceDocumentationUrl" | "scopesSupported">;
};

const checkIssuerUrl = (issuer: URL): void => {
  // Technically RFC 8414 does not permit a localhost HTTPS exemption, but this will be necessary for ease of testing
  if (issuer.protocol !== "https:" && issuer.hostname !== "localhost" && issuer.hostname !== "127.0.0.1") {
    throw new Error("Issuer URL must be HTTPS");
  }
  if (issuer.hash) {
    throw new Error(`Issuer URL must not have a fragment: ${issuer}`);
  }
  if (issuer.search) {
    throw new Error(`Issuer URL must not have a query string: ${issuer}`);
  }
}

/**
 * Installs standard MCP authorization endpoints, including dynamic client registration and token revocation (if supported). Also advertises standard authorization server metadata, for easier discovery of supported configurations by clients.
 *
 * By default, rate limiting is applied to all endpoints to prevent abuse.
 *
 * This router MUST be installed at the application root, like so:
 *
 *  const app = express();
 *  app.use(mcpAuthRouter(...));
 */
export function mcpAuthRouter(options: AuthRouterOptions): RequestHandler {
  const issuer = options.issuerUrl;
  const baseUrl = options.baseUrl;

  checkIssuerUrl(issuer);

  const authorization_endpoint = "/authorize";
  const token_endpoint = "/token";
  const registration_endpoint = options.provider.clientsStore.registerClient ? "/register" : undefined;
  const revocation_endpoint = options.provider.revokeToken ? "/revoke" : undefined;

  const metadata: OAuthMetadata = {
    issuer: issuer.href,
    service_documentation: options.serviceDocumentationUrl?.href,

    authorization_endpoint: new URL(authorization_endpoint, baseUrl || issuer).href,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],

    token_endpoint: new URL(token_endpoint, baseUrl || issuer).href,
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    grant_types_supported: ["authorization_code", "refresh_token"],

    scopes_supported: options.scopesSupported,

    revocation_endpoint: revocation_endpoint ? new URL(revocation_endpoint, baseUrl || issuer).href : undefined,
    revocation_endpoint_auth_methods_supported: revocation_endpoint ? ["client_secret_post"] : undefined,

    registration_endpoint: registration_endpoint ? new URL(registration_endpoint, baseUrl || issuer).href : undefined,
  };


  const router = express.Router();

  router.use(
    authorization_endpoint,
    authorizationHandler({ provider: options.provider, ...options.authorizationOptions })
  );

  router.use(
    token_endpoint,
    tokenHandler({ provider: options.provider, ...options.tokenOptions })
  );

  router.use("/.well-known/oauth-authorization-server", metadataHandler(metadata));

  // Always include protected resource metadata
  const defaultProtectedResourceOptions = {
    serverUrl: issuer, // Use issuer as default server URL
  };

  router.use(mcpProtectedResourceRouter({
    issuerUrl: issuer,
    serviceDocumentationUrl: options.serviceDocumentationUrl,
    scopesSupported: options.scopesSupported,
    ...defaultProtectedResourceOptions,
    ...options.protectedResourceOptions
  }))

  if (registration_endpoint) {
    router.use(
      registration_endpoint,
      clientRegistrationHandler({
        clientsStore: options.provider.clientsStore,
        ...options,
      })
    );
  }

  if (revocation_endpoint) {
    router.use(
      revocation_endpoint,
      revocationHandler({ provider: options.provider, ...options.revocationOptions })
    );
  }

  return router;
}


export type ProtectedResourceRouterOptions = {
  /**
   * The authorization server's issuer identifier, which is a URL that uses the "https" scheme and has no query or fragment components.
   */
  issuerUrl: URL;

  /**
   * The MCP server URL that is proteted.
   *
   */
  serverUrl: URL;

  /**
   * An optional URL of a page containing human-readable information that developers might want or need to know when using the authorization server.
   */
  serviceDocumentationUrl?: URL;

  /**
   * A list of valid scopes for the resource.
   */
  scopesSupported?: Array<string>;

  /**
   * A human readable resource name for the MCP server
   */
  resourceName?: string;
};


export function mcpProtectedResourceRouter(options: ProtectedResourceRouterOptions) {
  const issuer = options.issuerUrl;
  checkIssuerUrl(issuer);

  const router = express.Router();

  const protectedResourceMetadata: OAuthProtectedResourceMetadata = {
    resource: options.serverUrl.href,

    authorization_servers: [
      issuer.href
    ],

    scopes_supported: options.scopesSupported,
    resource_name: options.resourceName,
    resource_documentation: options.serviceDocumentationUrl?.href,
  };

  router.use("/.well-known/oauth-protected-resource", metadataHandler(protectedResourceMetadata));

  return router;
}

/**
 * Helper function to construct the OAuth 2.0 Protected Resource Metadata URL
 * from a given server URL. This replaces the path with the standard metadata endpoint.
 *
 * @param serverUrl - The base URL of the protected resource server
 * @returns The URL for the OAuth protected resource metadata endpoint
 *
 * @example
 * getOAuthProtectedResourceMetadataUrl(new URL('https://api.example.com/mcp'))
 * // Returns: 'https://api.example.com/.well-known/oauth-protected-resource'
 */
export function getOAuthProtectedResourceMetadataUrl(serverUrl: URL): string {
  return new URL('/.well-known/oauth-protected-resource', serverUrl).href;
}
