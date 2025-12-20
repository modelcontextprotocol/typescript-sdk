import type { OAuthClientInformationFull } from '@modelcontextprotocol/core';
import { InvalidClientError, InvalidRequestError } from '@modelcontextprotocol/core';
import * as z from 'zod/v4';

import type { OAuthRegisteredClientsStore } from '../clients.js';

export type ClientAuthenticationMiddlewareOptions = {
    /**
     * A store used to read information about registered OAuth clients.
     */
    clientsStore: OAuthRegisteredClientsStore;
};

const ClientAuthenticatedRequestSchema = z.object({
    client_id: z.string(),
    client_secret: z.string().optional()
});

/**
 * Parses and validates client credentials from a request body, returning the authenticated client.
 *
 * Throws an OAuthError (or ServerError) on failure.
 */
export async function authenticateClient(
    body: unknown,
    { clientsStore }: ClientAuthenticationMiddlewareOptions
): Promise<OAuthClientInformationFull> {
    const result = ClientAuthenticatedRequestSchema.safeParse(body);
    if (!result.success) {
        throw new InvalidRequestError(String(result.error));
    }
    const { client_id, client_secret } = result.data;
    const client = await clientsStore.getClient(client_id);
    if (!client) {
        throw new InvalidClientError('Invalid client_id');
    }
    if (client.client_secret) {
        if (!client_secret) {
            throw new InvalidClientError('Client secret is required');
        }
        if (client.client_secret !== client_secret) {
            throw new InvalidClientError('Invalid client_secret');
        }
        if (client.client_secret_expires_at && client.client_secret_expires_at < Math.floor(Date.now() / 1000)) {
            throw new InvalidClientError('Client secret has expired');
        }
    }

    return client;
}
