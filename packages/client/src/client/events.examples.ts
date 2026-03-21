/**
 * Type-checked examples for `events.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { Client } from './client.js';
import { ClientEventManager } from './events.js';

/**
 * Example: subscribing to an event and iterating over occurrences.
 */
async function ClientEventManager_basicUsage(client: Client, shouldStop: boolean) {
    //#region ClientEventManager_basicUsage
    const events = new ClientEventManager(client);
    const sub = await events.subscribe('email.received', { from: '*@example.com' });
    for await (const event of sub) {
        console.log('New email:', event.data);
        if (shouldStop) break;
    }
    // Leaving the loop auto-cancels via AsyncIterator.return().
    //#endregion ClientEventManager_basicUsage
}
