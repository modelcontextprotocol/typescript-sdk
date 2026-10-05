import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { auth, type OAuthClientProvider } from '../../src/client/auth';

const servers: Server[] = [];

function listen(server: Server): Promise<number> {
    servers.push(server);
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (address == null || typeof address === 'string') {
                reject(new Error('Unexpected server address'));
                return;
            }
            resolve(address.port);
        });
    });
}

async function closeServers(): Promise<void> {
    await Promise.all(
        servers.splice(0).map(
            server =>
                new Promise<void>(resolve => {
                    server.close(() => resolve());
                })
        )
    );
}

function createProvider(): OAuthClientProvider {
    return {
        get redirectUrl() {
            return 'http://127.0.0.1/callback';
        },
        get clientMetadata() {
            return { redirect_uris: ['http://127.0.0.1/callback'] };
        },
        clientInformation: async () => undefined,
        saveClientInformation: async () => {},
        tokens: async () => undefined,
        saveTokens: async () => {},
        redirectToAuthorization: async () => {},
        saveCodeVerifier: async () => {},
        codeVerifier: async () => 'verifier'
    };
}

describe('auth protected resource metadata validation', () => {
    afterEach(async () => {
        await closeServers();
    });

    it('surfaces schema validation failures from HTTP 200 protected resource metadata', async () => {
        const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
            if (request.url === '/.well-known/oauth-protected-resource') {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ authorization_servers: ['http://127.0.0.1:1'] }));
                return;
            }

            response.writeHead(404, { 'content-type': 'text/plain' });
            response.end('not found');
        });

        const port = await listen(server);

        await expect(auth(createProvider(), { serverUrl: `http://127.0.0.1:${port}` })).rejects.toThrow(
            /Invalid OAuth protected resource metadata/
        );
    });
});
