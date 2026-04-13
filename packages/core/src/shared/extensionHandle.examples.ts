/**
 * Type-checked examples for `extensionHandle.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 *
 * @module
 */

import * as z from 'zod/v4';

import type { JSONObject } from '../types/types.js';
import type { ExtensionHandle } from './extensionHandle.js';
import type { BaseContext } from './protocol.js';

// In practice, obtain a handle via `client.extension(...)` or `server.extension(...)`.
declare const ui: ExtensionHandle<{ availableModes: string[] }, { openLinks?: boolean }, BaseContext>;
declare function display(_: JSONObject): void;

/** Example: register handlers for an extension's custom methods. */
function ExtensionHandle_setRequestHandler_basic() {
    //#region ExtensionHandle_setRequestHandler_basic
    const OpenLinkParams = z.object({ url: z.string().url() });

    ui.setRequestHandler('ui/open-link', OpenLinkParams, async params => {
        // ... open params.url in the host UI
        return { opened: true };
    });

    ui.setNotificationHandler('ui/size-changed', z.object({ width: z.number(), height: z.number() }), params => {
        console.log(`resized to ${params.width}x${params.height}`);
    });
    //#endregion ExtensionHandle_setRequestHandler_basic
}

/** Example: send a request through the handle (peer-gated under enforceStrictCapabilities). */
async function ExtensionHandle_sendRequest_basic() {
    //#region ExtensionHandle_sendRequest_basic
    const OpenLinkResult = z.object({ opened: z.boolean() });

    const result = await ui.sendRequest('ui/open-link', { url: 'https://example.com' }, OpenLinkResult);
    console.log(result.opened);
    //#endregion ExtensionHandle_sendRequest_basic
}

/** Example: read the peer's advertised settings for this extension. */
function ExtensionHandle_getPeerSettings_basic() {
    //#region ExtensionHandle_getPeerSettings_basic
    const peer = ui.getPeerSettings();
    if (peer?.openLinks) {
        // peer supports the open-link feature
    }
    //#endregion ExtensionHandle_getPeerSettings_basic
    void display;
}

void ExtensionHandle_setRequestHandler_basic;
void ExtensionHandle_sendRequest_basic;
void ExtensionHandle_getPeerSettings_basic;
