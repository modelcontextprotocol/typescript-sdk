import type { OAuthClientInformationFull } from '@modelcontextprotocol/core';

import type { OAuthRegisteredClientsStore } from '../../../../src/server/auth/clients.js';
import { clientRegistrationHandler } from '../../../../src/server/auth/handlers/register.js';

describe('clientRegistrationHandler (web)', () => {
    it('returns 201 and client info when registration is supported', async () => {
        const clientsStore: OAuthRegisteredClientsStore = {
            async getClient() {
                return undefined;
            },
            async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) {
                // In real implementation, server may generate ids; here return minimal.
                return {
                    ...client,
                    client_id: 'generated-client',
                    client_id_issued_at: Math.floor(Date.now() / 1000),
                    redirect_uris: (client as any).redirect_uris ?? []
                } as unknown as OAuthClientInformationFull;
            }
        };

        const handler = clientRegistrationHandler({ clientsStore, rateLimit: false });

        const res = await handler(
            new Request('http://localhost/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    redirect_uris: ['https://example.com/callback']
                })
            })
        );

        expect(res.status).toBe(201);
        const body = (await res.json()) as { client_id?: string };
        expect(body.client_id).toBeDefined();
    });
});
