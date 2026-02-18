import type { FetchLike, OAuthAccessTokenResponseType, OAuthErrorFields, OAuthErrorType, OAuthTokenExchangeResponseType } from '@modelcontextprotocol/core';
import { OAuthClientAssertionType, OAuthErrorTypes, OAuthGrantType, OAuthTokenType } from '@modelcontextprotocol/core';
import qs from 'qs';

import { discoverAuthorizationServerMetadata } from './auth.js';
// ============================================================================
// TYPES
// ============================================================================

type OAuthError = OAuthErrorFields;

type ClientIdFields = {
    client_id: string;
    client_secret?: string;
};

type ClientAssertionFields = {
    client_assertion_type: OAuthClientAssertionType;
    client_assertion: string;
};

type ClientIdOption = {
    clientID: string;
    clientSecret?: string;
};

type ClientAssertionOption = {
    clientAssertion: string;
};

type ExchangeTokenResult =
    | {
          payload: OAuthTokenExchangeResponseType;
      }
    | {
          error: OAuthError | HttpResponse;
      };

type AccessTokenResult =
    | {
          payload: OAuthAccessTokenResponseType;
      }
    | {
          error: OAuthError | HttpResponse;
      };

type GetJwtAuthGrantBaseOptions = {
    tokenUrl: string;
    resource: string;
    audience: string;
    subjectTokenType: SubjectTokenType;
    subjectToken: string;
    scopes?: string | Set<string> | string[];
};

type SubjectTokenType = 'oidc' | 'saml';

type RequestFields = {
    grant_type: OAuthGrantType.TOKEN_EXCHANGE;
    requested_token_type: OAuthTokenType.JWT_ID_JAG;
    resource?: string;
    audience: string;
    scope: string;
    subject_token: string;
    subject_token_type: OAuthTokenType;
};

type ExchangeJwtAuthGrantBaseOptions = {
    tokenUrl: string;
    authorizationGrant: string;
    scopes?: string | Set<string> | string[];
};

type ExchangeRequestFields = {
    grant_type: OAuthGrantType.JWT_BEARER;
    assertion: string;
    scope: string;
};

export type XAAOptions = {
    idpUrl: string;
    mcpResourceUrl: string;
    mcpAuthorisationServerUrl: string;
    idToken: string;
    idpClientId: string;
    idpClientSecret: string;
    mcpClientId: string;
    mcpClientSecret: string;
    scope?: string[];
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

const invalidOAuthErrorResponse = (field: string, requirement: string, payload?: Record<string, unknown>) =>
    new InvalidPayloadError(
        `The field '${field}' ${requirement} per RFC6749. See https://datatracker.ietf.org/doc/html/rfc6749#section-5.2.`,
        { payload }
    );

const invalidRFC6749PayloadError = (field: string, requirement: string, payload?: Record<string, unknown>) =>
    new InvalidPayloadError(
        `The field '${field}' ${requirement} per RFC8693. See https://datatracker.ietf.org/doc/html/rfc6749#section-4.2.2.`,
        { payload }
    );

const invalidRFC7523PayloadError = (field: string, requirement: string, payload?: Record<string, unknown>) =>
    new InvalidPayloadError(
        `The field '${field}' ${requirement} per RFC7523. See https://datatracker.ietf.org/doc/html/rfc7523#section-2.1.`,
        { payload }
    );

const invalidRFC8693PayloadError = (field: string, requirement: string, payload?: Record<string, unknown>) =>
    new InvalidPayloadError(
        `The field '${field}' ${requirement} per RFC8693. See https://datatracker.ietf.org/doc/html/rfc8693#section-2.2.1.`,
        { payload }
    );

const transformScopes = (scopes?: string | Set<string> | string[] | null) => {
    if (scopes) {
        if (Array.isArray(scopes)) {
            return scopes.join(' ');
        }

        if (scopes instanceof Set) {
            return [...scopes].join(' ');
        }

        if (typeof scopes === 'string') {
            return scopes;
        }

        throw new InvalidArgumentError('scopes', 'Expected a valid string, array of strings, or Set of strings.');
    }

    return '';
};

// ============================================================================
// METHODS
// ============================================================================

const requestIdJwtAuthzGrant = async (
    opts: GetJwtAuthGrantBaseOptions & (ClientIdOption | ClientAssertionOption),
    wrappedFetchFunction: FetchLike
): Promise<ExchangeTokenResult> => {
    const { resource, subjectToken, subjectTokenType, audience, scopes, tokenUrl } = opts;

    if (!tokenUrl || typeof tokenUrl !== 'string') {
        throw new InvalidArgumentError('opts.tokenUrl', 'A valid url is required.');
    }

    if (!resource || typeof resource !== 'string') {
        throw new InvalidArgumentError('opts.resource', 'A valid string is required.');
    }

    if (!audience || typeof audience !== 'string') {
        throw new InvalidArgumentError('opts.audience', 'A valid string is required.');
    }

    if (!subjectToken || typeof subjectToken !== 'string') {
        throw new InvalidArgumentError('opts.subjectToken');
    }

    let subjectTokenUrn: OAuthTokenType;

    switch (subjectTokenType) {
        case 'saml': {
            subjectTokenUrn = OAuthTokenType.SAML2;
            break;
        }
        case 'oidc': {
            subjectTokenUrn = OAuthTokenType.ID_TOKEN;
            break;
        }
        default: {
            throw new InvalidArgumentError('opts.subjectTokenType', 'A valid SubjectTokenType constant is required.');
        }
    }

    const scope = transformScopes(scopes);

    let clientAssertionData: ClientIdFields | ClientAssertionFields;

    if ('clientID' in opts) {
        clientAssertionData = {
            client_id: opts.clientID,
            ...(opts.clientSecret ? { client_secret: opts.clientSecret } : null)
        };
    } else if ('clientAssertion' in opts) {
        clientAssertionData = {
            client_assertion_type: OAuthClientAssertionType.JWT_BEARER,
            client_assertion: opts.clientAssertion
        };
    } else {
        throw new InvalidArgumentError('opts.clientAssertion', 'Expected a valid client assertion jwt or client id and secret.');
    }

    const requestData: RequestFields & (ClientIdFields | ClientAssertionFields) = {
        grant_type: OAuthGrantType.TOKEN_EXCHANGE,
        requested_token_type: OAuthTokenType.JWT_ID_JAG,
        audience,
        resource,
        scope,
        subject_token: subjectToken,
        subject_token_type: subjectTokenUrn,
        ...clientAssertionData
    };

    const body = qs.stringify(requestData);

    const response = await wrappedFetchFunction(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });

    const resStatus = response.status;

    if (resStatus === 400) {
        return {
            error: new OAuthBadRequest((await response.json()) as Record<string, unknown>)
        };
    }

    if (resStatus > 200 && resStatus < 600) {
        return {
            error: new HttpResponse(response.url, response.status, response.statusText, await response.text())
        };
    }

    const payload = new OauthTokenExchangeResponse((await response.json()) as Record<string, unknown>);

    if (payload.issued_token_type !== OAuthTokenType.JWT_ID_JAG) {
        throw new InvalidPayloadError(
            `The field 'issued_token_type' must have the value '${OAuthTokenType.JWT_ID_JAG}' per the Identity Assertion Authorization Grant Draft Section 5.2.`
        );
    }

    if (payload.token_type.toLowerCase() !== 'n_a') {
        throw new InvalidPayloadError(
            `The field 'token_type' must have the value 'n_a' per the Identity Assertion Authorization Grant Draft Section 5.2.`
        );
    }

    return { payload };
};

const exchangeIdJwtAuthzGrant = async (
    opts: ExchangeJwtAuthGrantBaseOptions & (ClientIdOption | ClientAssertionOption),
    wrappedFetchFunction: FetchLike
): Promise<AccessTokenResult> => {
    const { tokenUrl, authorizationGrant, scopes } = opts;

    if (!tokenUrl || typeof tokenUrl !== 'string') {
        throw new InvalidArgumentError('opts.tokenUrl', 'A valid url is required.');
    }

    if (!authorizationGrant || typeof authorizationGrant !== 'string') {
        throw new InvalidArgumentError('opts.authorizationGrant', 'A valid authorization grant is required.');
    }

    const scope = transformScopes(scopes);

    let clientAssertionData: ClientIdFields | ClientAssertionFields;

    if ('clientID' in opts) {
        clientAssertionData = {
            client_id: opts.clientID,
            ...(opts.clientSecret ? { client_secret: opts.clientSecret } : null)
        };
    } else if ('clientAssertion' in opts) {
        clientAssertionData = {
            client_assertion_type: OAuthClientAssertionType.JWT_BEARER,
            client_assertion: opts.clientAssertion
        };
    } else {
        throw new InvalidArgumentError('opts.clientAssertion', 'Expected a valid client assertion jwt or client id and secret.');
    }

    const requestData: ExchangeRequestFields & (ClientIdFields | ClientAssertionFields) = {
        grant_type: OAuthGrantType.JWT_BEARER,
        assertion: authorizationGrant,
        scope,
        ...clientAssertionData
    };

    const body = qs.stringify(requestData);

    const response = await wrappedFetchFunction(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body
    });

    const resStatus = response.status;

    if (resStatus === 400) {
        return {
            error: new OAuthBadRequest((await response.json()) as Record<string, unknown>)
        };
    }

    if (resStatus > 200 && resStatus < 600) {
        return {
            error: new HttpResponse(response.url, response.status, response.statusText, await response.text())
        };
    }

    const payload = new OauthJwtBearerAccessTokenResponse((await response.json()) as Record<string, unknown>);

    return { payload };
};

/**
 * Retrieving an access token using the Id jag exchange
 * @param options
 * @param wrappedFetchFunction
 * @returns access token string
 */
export const getAccessToken = async (options: XAAOptions, wrappedFetchFunction: FetchLike): Promise<string | undefined> => {
    let authGrantResponse: ExchangeTokenResult;
    try {
        const idpMetadata = await discoverAuthorizationServerMetadata(options.idpUrl, {
            fetchFn: wrappedFetchFunction
        });
        //Since subjecttokentype currently only supports oidc, we hardcode it here
        authGrantResponse = await requestIdJwtAuthzGrant(
            {
                tokenUrl: idpMetadata?.token_endpoint || options.idpUrl,
                audience: options.mcpAuthorisationServerUrl,
                resource: options.mcpResourceUrl,
                subjectToken: options.idToken,
                subjectTokenType: 'oidc',
                scopes: options.scope,
                clientID: options.idpClientId,
                clientSecret: options.idpClientSecret
            },
            wrappedFetchFunction
        );
    } catch (error: unknown) {
        throw new Error(`Failed to obtain authorization grant : ${error}`);
    }

    if ('error' in authGrantResponse) {
        throw new Error('Failed to obtain authorization grant');
    }

    const { payload: authGrantToken } = authGrantResponse;

    let accessTokenResponse: AccessTokenResult;

    try {
        const mcpMetadata = await discoverAuthorizationServerMetadata(options.mcpAuthorisationServerUrl, {
            fetchFn: wrappedFetchFunction
        });
        accessTokenResponse = await exchangeIdJwtAuthzGrant(
            {
                tokenUrl: mcpMetadata?.token_endpoint || options.mcpAuthorisationServerUrl,
                authorizationGrant: authGrantToken.access_token,
                scopes: options.scope,
                clientID: options.mcpClientId,
                clientSecret: options.mcpClientSecret
            },
            wrappedFetchFunction
        );
    } catch (error: unknown) {
        throw new Error(`Failed to exchange the authorization grant for access token: ${error}`);
    }

    if ('error' in accessTokenResponse) {
        throw new Error(`Failed to exchange authorization grant for access token`);
    }
    return accessTokenResponse.payload.access_token;
};

// ============================================================================
// CLASSES
// ============================================================================

class InvalidArgumentError extends Error {
    constructor(argument: string, message?: string) {
        super(`Invalid argument ${argument}.${message ? ` ${message}` : ''}`);
        this.name = this.constructor.name;
    }
}

class InvalidPayloadError extends Error {
    data?: Record<string, unknown>;

    constructor(message: string, data?: Record<string, unknown>) {
        super(`Invalid payload. ${message}`);
        this.name = this.constructor.name;
        if (data && typeof data === 'object') {
            this.data = data;
        }
    }
}

class HttpResponse {
    url: string;

    status: number;

    statusText: string;

    body?: string;

    constructor(url: string, status: number, statusText: string, body?: string) {
        this.url = url;
        this.status = status;
        this.statusText = statusText;
        this.body = body;
    }
}

class OAuthBadRequest implements OAuthError {
    error: OAuthErrorType;

    error_description?: string;

    error_uri?: string;

    constructor(payload: Record<string, unknown>) {
        const { error, error_description, error_uri } = payload as OAuthError;

        if (!error || !OAuthErrorTypes.includes(error)) {
            throw invalidOAuthErrorResponse('error', 'must be present and a valid value', payload);
        }

        this.error = error;

        if (error_description) {
            if (typeof error_description !== 'string') {
                throw invalidOAuthErrorResponse('error_description', 'must be a valid string', payload);
            }

            this.error_description = error_description;
        }

        if (error_uri) {
            if (typeof error_uri !== 'string') {
                throw invalidOAuthErrorResponse('error_uri', 'must be a valid string', payload);
            }

            this.error_uri = error_uri;
        }
    }
}

class OauthJwtBearerAccessTokenResponse implements OAuthAccessTokenResponseType {
    access_token: string;

    token_type: string;

    scope?: string;

    expires_in?: number;

    refresh_token?: string;

    constructor(payload: Record<string, unknown>) {
        const { access_token, token_type, scope, expires_in, refresh_token } = payload as OAuthAccessTokenResponseType;

        if (!access_token || typeof access_token !== 'string') {
            throw invalidRFC6749PayloadError('access_token', 'must be present and a valid value', payload);
        }

        this.access_token = access_token;

        if (!token_type || typeof token_type !== 'string' || token_type.toLowerCase() !== 'bearer') {
            throw invalidRFC7523PayloadError('token_type', "must have the value 'bearer'", payload);
        }

        this.token_type = token_type;

        if (scope && typeof scope === 'string') {
            this.scope = scope;
        }

        if (typeof expires_in === 'number' && expires_in > 0) {
            this.expires_in = expires_in;
        }

        if (refresh_token && typeof refresh_token === 'string') {
            this.refresh_token = refresh_token;
        }
    }
}

class OauthTokenExchangeResponse implements OAuthTokenExchangeResponseType {
    access_token: string;

    issued_token_type: OAuthTokenType;

    token_type: string;

    scope?: string;

    expires_in?: number;

    refresh_token?: string;

    constructor(payload: Record<string, unknown>) {
        const { access_token, issued_token_type, token_type, scope, expires_in, refresh_token } = payload as OAuthTokenExchangeResponseType;

        if (!access_token || typeof access_token !== 'string') {
            throw invalidRFC8693PayloadError('access_token', 'must be present and a valid value', payload);
        }

        this.access_token = access_token;

        if (!issued_token_type || typeof issued_token_type !== 'string') {
            throw invalidRFC8693PayloadError('issued_token_type', 'must be present and a valid value', payload);
        }

        this.issued_token_type = issued_token_type;

        if (!token_type || typeof token_type !== 'string') {
            throw invalidRFC8693PayloadError('token_type', 'must be present and a valid value', payload);
        }

        this.token_type = token_type;

        if (scope && typeof scope === 'string') {
            this.scope = scope;
        }

        if (typeof expires_in === 'number' && expires_in > 0) {
            this.expires_in = expires_in;
        }

        if (refresh_token && typeof refresh_token === 'string') {
            this.refresh_token = refresh_token;
        }
    }
}
