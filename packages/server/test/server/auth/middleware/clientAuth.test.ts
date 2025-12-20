import type { OAuthClientInformationFull } from '@modelcontextprotocol/core';
import { InvalidClientError, InvalidRequestError } from '@modelcontextprotocol/core';

import type { OAuthRegisteredClientsStore } from '../../../../src/server/auth/clients.js';
import type { ClientAuthenticationMiddlewareOptions } from '../../../../src/server/auth/middleware/clientAuth.js';
import { authenticateClient } from '../../../../src/server/auth/middleware/clientAuth.js';

describe('authenticateClient', () => {
    // Mock client store
    const mockClientStore: OAuthRegisteredClientsStore = {
        async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
            if (clientId === 'valid-client') {
                return {
                    client_id: 'valid-client',
                    client_secret: 'valid-secret',
                    redirect_uris: ['https://example.com/callback']
                };
            } else if (clientId === 'expired-client') {
                // Client with no secret
                return {
                    client_id: 'expired-client',
                    redirect_uris: ['https://example.com/callback']
                };
            } else if (clientId === 'client-with-expired-secret') {
                // Client with an expired secret
                return {
                    client_id: 'client-with-expired-secret',
                    client_secret: 'expired-secret',
                    client_secret_expires_at: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
                    redirect_uris: ['https://example.com/callback']
                };
            }
            return undefined;
        }
    };

    let options: ClientAuthenticationMiddlewareOptions;

    beforeEach(() => {
        options = {
            clientsStore: mockClientStore
        };
    });

    it('authenticates valid client credentials', async () => {
        const client = await authenticateClient(
            {
                client_id: 'valid-client',
                client_secret: 'valid-secret'
            },
            options
        );

        expect(client.client_id).toBe('valid-client');
    });

    it('rejects invalid client_id', async () => {
        await expect(
            authenticateClient(
                {
                    client_id: 'non-existent-client',
                    client_secret: 'some-secret'
                },
                options
            )
        ).rejects.toBeInstanceOf(InvalidClientError);
    });

    it('rejects invalid client_secret', async () => {
        await expect(
            authenticateClient(
                {
                    client_id: 'valid-client',
                    client_secret: 'wrong-secret'
                },
                options
            )
        ).rejects.toBeInstanceOf(InvalidClientError);
    });

    it('rejects missing client_id', async () => {
        await expect(
            authenticateClient(
                {
                    client_secret: 'valid-secret'
                },
                options
            )
        ).rejects.toBeInstanceOf(InvalidRequestError);
    });

    it('allows missing client_secret if client has none', async () => {
        const client = await authenticateClient(
            {
                client_id: 'expired-client'
            },
            options
        );
        expect(client.client_id).toBe('expired-client');
    });

    it('rejects request when client secret has expired', async () => {
        await expect(
            authenticateClient(
                {
                    client_id: 'client-with-expired-secret',
                    client_secret: 'expired-secret'
                },
                options
            )
        ).rejects.toBeInstanceOf(InvalidClientError);
    });

    it('ignores extra fields in request', async () => {
        const client = await authenticateClient(
            {
                client_id: 'valid-client',
                client_secret: 'valid-secret',
                extra_field: 'ignored'
            },
            options
        );
        expect(client.client_id).toBe('valid-client');
    });
});
