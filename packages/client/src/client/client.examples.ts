/**
 * Type-checked examples for `client.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { Client } from './client.js';

/**
 * Example: Using listChanged to automatically track tool and prompt updates.
 */
function ClientOptions_listChanged() {
    //#region ClientOptions_listChanged
    const client = new Client(
        { name: 'my-client', version: '1.0.0' },
        {
            listChanged: {
                tools: {
                    onChanged: (error, tools) => {
                        if (error) {
                            console.error('Failed to refresh tools:', error);
                            return;
                        }
                        console.log('Tools updated:', tools);
                    }
                },
                prompts: {
                    onChanged: (error, prompts) => console.log('Prompts updated:', prompts)
                }
            }
        }
    );
    //#endregion ClientOptions_listChanged
    return client;
}
