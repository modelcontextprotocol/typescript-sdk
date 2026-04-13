/**
 * Type-checked examples for `protocol.ts` (custom-method API).
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 *
 * @module
 */

import * as z from 'zod/v4';

import type { Protocol } from './protocol.js';

// The custom-method API is inherited by both Client and Server. Examples here use a
// generic `peer` of type `Protocol<never>` to keep them role-neutral; in practice
// callers use `client.setCustomRequestHandler(...)` or `server.setCustomRequestHandler(...)`.
declare const peer: Protocol<never>;

/** Example: Register a handler for a vendor-specific request method. */
function Protocol_setCustomRequestHandler_basic() {
    //#region Protocol_setCustomRequestHandler_basic
    const SearchParams = z.object({ query: z.string(), limit: z.number().optional() });

    peer.setCustomRequestHandler('acme/search', SearchParams, async params => {
        return { hits: [`result for ${params.query}`] };
    });
    //#endregion Protocol_setCustomRequestHandler_basic
}

/** Example: Register a handler for a vendor-specific notification. */
function Protocol_setCustomNotificationHandler_basic() {
    //#region Protocol_setCustomNotificationHandler_basic
    const ProgressParams = z.object({ percent: z.number() });

    peer.setCustomNotificationHandler('acme/progress', ProgressParams, params => {
        console.log(`progress: ${params.percent}%`);
    });
    //#endregion Protocol_setCustomNotificationHandler_basic
}

/** Example: Send a custom request and await the typed result. */
async function Protocol_sendCustomRequest_basic() {
    //#region Protocol_sendCustomRequest_basic
    const SearchResult = z.object({ hits: z.array(z.string()) });

    const result = await peer.sendCustomRequest('acme/search', { query: 'widgets' }, SearchResult);
    console.log(result.hits);
    //#endregion Protocol_sendCustomRequest_basic
}

/** Example: Send a custom request with both params and result schemas (pre-send validation). */
async function Protocol_sendCustomRequest_bundle() {
    //#region Protocol_sendCustomRequest_bundle
    const SearchParams = z.object({ query: z.string() });
    const SearchResult = z.object({ hits: z.array(z.string()) });

    // Passing { params, result } validates outbound params before sending and types both ends.
    const result = await peer.sendCustomRequest('acme/search', { query: 'widgets' }, { params: SearchParams, result: SearchResult });
    console.log(result.hits);
    //#endregion Protocol_sendCustomRequest_bundle
}

/** Example: Send a custom notification. */
async function Protocol_sendCustomNotification_basic() {
    //#region Protocol_sendCustomNotification_basic
    await peer.sendCustomNotification('acme/heartbeat', { timestamp: Date.now() });
    //#endregion Protocol_sendCustomNotification_basic
}

void Protocol_setCustomRequestHandler_basic;
void Protocol_setCustomNotificationHandler_basic;
void Protocol_sendCustomRequest_basic;
void Protocol_sendCustomRequest_bundle;
void Protocol_sendCustomNotification_basic;
