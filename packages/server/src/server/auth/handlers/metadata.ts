import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/core';

import type { WebHandler } from '../web.js';
import { corsHeaders, corsPreflightResponse, jsonResponse, methodNotAllowedResponse } from '../web.js';

export function metadataHandler(metadata: OAuthMetadata | OAuthProtectedResourceMetadata): WebHandler {
    const cors = {
        allowOrigin: '*',
        allowMethods: ['GET', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
        maxAgeSeconds: 60 * 60 * 24
    } as const;

    return async req => {
        if (req.method === 'OPTIONS') {
            return corsPreflightResponse(cors);
        }
        if (req.method !== 'GET') {
            const resp = methodNotAllowedResponse(req, ['GET', 'OPTIONS']);
            // Add CORS headers for consistency with successful responses.
            const body = await resp.text();
            return new Response(body, {
                status: resp.status,
                headers: { ...Object.fromEntries(resp.headers.entries()), ...corsHeaders(cors) }
            });
        }

        return jsonResponse(metadata, {
            status: 200,
            headers: corsHeaders(cors)
        });
    };
}
