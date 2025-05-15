import { z } from "zod";

/**
 * RFC 8414 OAuth 2.0 Authorization Server Metadata
 */
export const OAuthMetadataSchema = z
  .object({
    issuer: z.string(),
    authorization_endpoint: z.string(),
    token_endpoint: z.string(),
    registration_endpoint: z.string().optional(),
    scopes_supported: z.array(z.string()).optional(),
    response_types_supported: z.array(z.string()),
    response_modes_supported: z.array(z.string()).optional(),
    grant_types_supported: z.array(z.string()).optional(),
    token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
    token_endpoint_auth_signing_alg_values_supported: z
      .array(z.string())
      .optional(),
    service_documentation: z.string().optional(),
    revocation_endpoint: z.string().optional(),
    revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
    revocation_endpoint_auth_signing_alg_values_supported: z
      .array(z.string())
      .optional(),
    introspection_endpoint: z.string().optional(),
    introspection_endpoint_auth_methods_supported: z
      .array(z.string())
      .optional(),
    introspection_endpoint_auth_signing_alg_values_supported: z
      .array(z.string())
      .optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
  })
  .passthrough();

/**
 * OAuth 2.1 token response
 */
export const OAuthTokensSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string(),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
    refresh_token: z.string().optional(),
  })
  .strip();

/**
 * OAuth 2.1 error response
 */
export const OAuthErrorResponseSchema = z
  .object({
    error: z.string(),
    error_description: z.string().optional(),
    error_uri: z.string().optional(),
  });

/**
 * RFC 7591 OAuth 2.0 Dynamic Client Registration metadata
 */
export const OAuthClientMetadataSchema = z.object({
  redirect_uris: z.array(z.string()).refine((uris) => uris.every((uri) => URL.canParse(uri)), { message: "redirect_uris must contain valid URLs" }),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  client_name: z.string().optional(),
  client_uri: z.string().optional(),
  logo_uri: z.string().optional(),
  scope: z.string().optional(),
  contacts: z.array(z.string()).optional(),
  tos_uri: z.string().optional(),
  policy_uri: z.string().optional(),
  jwks_uri: z.string().optional(),
  jwks: z.any().optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
}).strip();

/**
 * RFC 7591 OAuth 2.0 Dynamic Client Registration client information
 */
export const OAuthClientInformationSchema = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
}).strip();

/**
 * RFC 7591 OAuth 2.0 Dynamic Client Registration full response (client information plus metadata)
 */
export const OAuthClientInformationFullSchema = OAuthClientMetadataSchema.merge(OAuthClientInformationSchema);

/**
 * RFC 7591 OAuth 2.0 Dynamic Client Registration error response
 */
export const OAuthClientRegistrationErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
}).strip();

/**
 * RFC 7009 OAuth 2.0 Token Revocation request
 */
export const OAuthTokenRevocationRequestSchema = z.object({
  token: z.string(),
  token_type_hint: z.string().optional(),
}).strip();

/**
 * RFC 9728 OAuth Protected Resource Metadata
 */
 export const OAuthProtectedResourceMetadataSchema = z.object({
   // REQUIRED fields
   resource: z.string().url(),

   // OPTIONAL fields
   authorization_servers: z.array(z.string().url()).optional(),

   jwks_uri: z.string().url().optional(),

   scopes_supported: z.array(z.string()).optional(),

   bearer_methods_supported: z.array(z.string()).optional(),

   resource_signing_alg_values_supported: z.array(z.string()).optional(),

   resource_name: z.string().optional(),

   resource_documentation: z.string().url().optional(),

   resource_policy_uri: z.string().url().optional(),

   resource_tos_uri: z.string().url().optional(),

   tls_client_certificate_bound_access_tokens: z.boolean().optional(),

   authorization_details_types_supported: z.array(z.string()).optional(),

   dpop_signing_alg_values_supported: z.array(z.string()).optional(),

   dpop_bound_access_tokens_required: z.boolean().optional(),

   // Signed metadata JWT
   signed_metadata: z.string().optional()
 }).strict();

export type OAuthMetadata = z.infer<typeof OAuthMetadataSchema>;
export type OAuthTokens = z.infer<typeof OAuthTokensSchema>;
export type OAuthErrorResponse = z.infer<typeof OAuthErrorResponseSchema>;
export type OAuthClientMetadata = z.infer<typeof OAuthClientMetadataSchema>;
export type OAuthClientInformation = z.infer<typeof OAuthClientInformationSchema>;
export type OAuthClientInformationFull = z.infer<typeof OAuthClientInformationFullSchema>;
export type OAuthClientRegistrationError = z.infer<typeof OAuthClientRegistrationErrorSchema>;
export type OAuthTokenRevocationRequest = z.infer<typeof OAuthTokenRevocationRequestSchema>;
export type OAuthProtectedResourceMetadata = z.infer<typeof OAuthProtectedResourceMetadataSchema>;
