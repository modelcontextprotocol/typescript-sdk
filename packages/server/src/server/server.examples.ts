/**
 * Type-checked examples for `server.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 *
 * @module
 */

import * as z from 'zod/v4';

import { Server } from './server.js';

/** Example: declare an SEP-2133 extension and wire its handlers. */
function Server_extension_basic() {
    //#region Server_extension_basic
    const server = new Server({ name: 'host', version: '1.0.0' }, { capabilities: {} });

    const ui = server.extension(
        'io.modelcontextprotocol/ui',
        { openLinks: true }, // advertised in capabilities.extensions[id]
        { peerSchema: z.object({ availableModes: z.array(z.string()) }) }
    );

    ui.setRequestHandler('ui/open-link', z.object({ url: z.string() }), async params => {
        return { opened: params.url.startsWith('https://') };
    });

    // After connect(): read what the client advertised for this extension
    const clientUiSettings = ui.getPeerSettings(); // { availableModes: string[] } | undefined
    //#endregion Server_extension_basic
    void clientUiSettings;
    return server;
}

void Server_extension_basic;
