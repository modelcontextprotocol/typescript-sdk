/**
 * Framework-agnostic Origin validation helpers: allowlist matching, the
 * absent-header pass, and the deny-on-failure behavior for malformed values.
 */
import { describe, expect, it } from 'vitest';

import { localhostAllowedOrigins, originValidationResponse, validateOriginHeader } from '../../src/server/middleware/originValidation';
import { McpServer } from '../../src/server/mcp';
import type { WebStandardStreamableHTTPServerTransportOptions } from '../../src/server/streamableHttp';
import { WebStandardStreamableHTTPServerTransport } from '../../src/server/streamableHttp';

describe('validateOriginHeader', () => {
    it('passes when no Origin header is present (non-browser clients)', () => {
        expect(validateOriginHeader(undefined, ['localhost']).ok).toBe(true);
        expect(validateOriginHeader(null, ['localhost']).ok).toBe(true);
        expect(validateOriginHeader('', ['localhost']).ok).toBe(true);
    });

    it('allows origins whose hostname is on the allowlist, port- and scheme-agnostic', () => {
        expect(validateOriginHeader('http://localhost:3000', ['localhost']).ok).toBe(true);
        expect(validateOriginHeader('https://localhost', ['localhost']).ok).toBe(true);
        expect(validateOriginHeader('http://127.0.0.1:8080', localhostAllowedOrigins()).ok).toBe(true);
        expect(validateOriginHeader('http://[::1]:8080', localhostAllowedOrigins()).ok).toBe(true);
    });

    it('rejects origins whose hostname is not on the allowlist', () => {
        const result = validateOriginHeader('http://evil.example.com', localhostAllowedOrigins());
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.errorCode).toBe('invalid_origin');
            expect(result.message).toContain('evil.example.com');
        }
    });

    it('rejects lookalike subdomains of allowed hostnames', () => {
        expect(validateOriginHeader('http://localhost.evil.example.com', localhostAllowedOrigins()).ok).toBe(false);
    });

    it('denies on failure: unparseable Origin values and the opaque null origin are rejected, never passed through', () => {
        for (const malformed of ['null', 'not a url', 'evil.example.com', 'about:blank']) {
            const result = validateOriginHeader(malformed, localhostAllowedOrigins());
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.errorCode).toBe('invalid_origin_header');
            }
        }
    });
});

describe('originValidationResponse', () => {
    it('returns undefined for allowed and absent origins', () => {
        const allowed = new Request('http://localhost/mcp', { headers: { origin: 'http://localhost:3000' } });
        expect(originValidationResponse(allowed, localhostAllowedOrigins())).toBeUndefined();

        const absent = new Request('http://localhost/mcp');
        expect(originValidationResponse(absent, localhostAllowedOrigins())).toBeUndefined();
    });

    it('returns a 403 JSON-RPC error response for disallowed origins', async () => {
        const request = new Request('http://localhost/mcp', { headers: { origin: 'http://evil.example.com' } });
        const response = originValidationResponse(request, localhostAllowedOrigins());
        expect(response).toBeDefined();
        expect(response!.status).toBe(403);
        const body = (await response!.json()) as { jsonrpc: string; error: { code: number; message: string }; id: unknown };
        expect(body.jsonrpc).toBe('2.0');
        expect(body.error.code).toBe(-32_000);
        expect(body.error.message).toContain('Invalid Origin');
        expect(body.id).toBeNull();
    });
});

describe('WebStandardStreamableHTTPServerTransport DNS rebinding protection', () => {
    const initializeBody = JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
            clientInfo: { name: 'test-client', version: '1.0' },
            protocolVersion: '2025-11-25',
            capabilities: {}
        },
        id: 'init-1'
    });

    async function createTransport(
        options: WebStandardStreamableHTTPServerTransportOptions = {}
    ): Promise<{ transport: WebStandardStreamableHTTPServerTransport; mcpServer: McpServer }> {
        const mcpServer = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });
        const transport = new WebStandardStreamableHTTPServerTransport(options);
        await mcpServer.connect(transport);
        return { transport, mcpServer };
    }

    function postRequest(url: string, headers: Record<string, string> = {}): Request {
        return new Request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
            body: initializeBody
        });
    }

    async function expectForbidden(response: Response): Promise<void> {
        expect(response.status).toBe(403);
        const body = (await response.json()) as { jsonrpc: string; error: { code: number; message: string }; id: unknown };
        expect(body.jsonrpc).toBe('2.0');
        expect(body.error.code).toBe(-32_000);
        expect(body.id).toBeNull();
    }

    it('default construction rejects a non-localhost Host header with 403', async () => {
        const { transport } = await createTransport();
        try {
            const response = await transport.handleRequest(
                postRequest('http://localhost:3000/mcp', { host: 'evil.example.com', origin: 'http://evil.example.com' })
            );
            await expectForbidden(response);
        } finally {
            await transport.close();
        }
    });

    it('default construction accepts a cross-origin Origin header when the Host is localhost', async () => {
        // Browser-origin hosting is typically delegated to an external CORS
        // middleware; the transport's default DNS rebinding protection
        // validates the Host header, not the Origin header.
        const { transport } = await createTransport();
        try {
            const response = await transport.handleRequest(
                postRequest('http://localhost:3000/mcp', { host: 'localhost:3000', origin: 'http://dashboard.example.com' })
            );
            expect(response.status).toBe(200);
            await response.body?.cancel();
        } finally {
            await transport.close();
        }
    });

    it('default construction accepts a localhost request (Host and Origin, any port)', async () => {
        const { transport } = await createTransport();
        try {
            const response = await transport.handleRequest(
                postRequest('http://localhost:3000/mcp', { host: 'localhost:3000', origin: 'http://localhost:3000' })
            );
            expect(response.status).toBe(200);
            await response.body?.cancel();
        } finally {
            await transport.close();
        }
    });

    it('default construction accepts requests without Host/Origin headers (non-browser clients)', async () => {
        const { transport } = await createTransport();
        try {
            const response = await transport.handleRequest(postRequest('http://localhost:3000/mcp'));
            expect(response.status).toBe(200);
            await response.body?.cancel();
        } finally {
            await transport.close();
        }
    });

    it('explicit enableDnsRebindingProtection: false allows cross-origin requests', async () => {
        const { transport } = await createTransport({ enableDnsRebindingProtection: false });
        try {
            const response = await transport.handleRequest(
                postRequest('http://localhost:3000/mcp', { host: 'evil.example.com', origin: 'http://evil.example.com' })
            );
            expect(response.status).toBe(200);
            await response.body?.cancel();
        } finally {
            await transport.close();
        }
    });

    it('empty allowlists with protection enabled fall back to the localhost Host allowlist', async () => {
        const { transport } = await createTransport({ enableDnsRebindingProtection: true, allowedHosts: [], allowedOrigins: [] });
        try {
            const local = await transport.handleRequest(
                postRequest('http://localhost:3000/mcp', { host: 'localhost:3000', origin: 'http://localhost:3000' })
            );
            expect(local.status).toBe(200);
            await local.body?.cancel();

            const badHost = await transport.handleRequest(postRequest('http://localhost:3000/mcp', { host: 'evil.example.com' }));
            await expectForbidden(badHost);
        } finally {
            await transport.close();
        }
    });

    it('explicit allowedOrigins rejects a non-allowed Origin header with 403', async () => {
        const { transport } = await createTransport({
            enableDnsRebindingProtection: true,
            allowedOrigins: ['http://dashboard.example.com']
        });
        try {
            const allowed = await transport.handleRequest(
                postRequest('http://localhost:3000/mcp', { host: 'localhost:3000', origin: 'http://dashboard.example.com' })
            );
            expect(allowed.status).toBe(200);
            await allowed.body?.cancel();

            const rejected = await transport.handleRequest(
                postRequest('http://localhost:3000/mcp', { host: 'localhost:3000', origin: 'http://evil.example.com' })
            );
            await expectForbidden(rejected);
        } finally {
            await transport.close();
        }
    });

    it('the localhost fallback is port-agnostic and covers 127.0.0.1', async () => {
        const { transport } = await createTransport();
        try {
            const response = await transport.handleRequest(
                postRequest('http://127.0.0.1:8080/mcp', { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' })
            );
            expect(response.status).toBe(200);
            await response.body?.cancel();
        } finally {
            await transport.close();
        }
    });
});
