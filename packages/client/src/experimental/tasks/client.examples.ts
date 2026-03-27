/**
 * Type-checked examples for `client.ts`.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import type { RequestOptions } from '@modelcontextprotocol/core';

import type { Client } from '../../client/client.js';

/**
 * Example: Using callToolStream to execute a tool with task lifecycle events.
 */
async function ExperimentalClientTasks_callToolStream(client: Client) {
    //#region ExperimentalClientTasks_callToolStream
    const stream = client.experimental.tasks.callToolStream({ name: 'myTool', arguments: {} });
    for await (const message of stream) {
        switch (message.type) {
            case 'taskCreated': {
                console.log('Tool execution started:', message.task.taskId);
                break;
            }
            case 'taskStatus': {
                console.log('Tool status:', message.task.status);
                break;
            }
            case 'result': {
                console.log('Tool result:', message.result);
                break;
            }
            case 'error': {
                console.error('Tool error:', message.error);
                break;
            }
        }
    }
    //#endregion ExperimentalClientTasks_callToolStream
}

/**
 * Example: Using requestStream to consume task lifecycle events for any request type.
 */
async function ExperimentalClientTasks_requestStream(client: Client, options: RequestOptions) {
    //#region ExperimentalClientTasks_requestStream
    const stream = client.experimental.tasks.requestStream({ method: 'tools/call', params: { name: 'my-tool', arguments: {} } }, options);
    for await (const message of stream) {
        switch (message.type) {
            case 'taskCreated': {
                console.log('Task created:', message.task.taskId);
                break;
            }
            case 'taskStatus': {
                console.log('Task status:', message.task.status);
                break;
            }
            case 'result': {
                console.log('Final result:', message.result);
                break;
            }
            case 'error': {
                console.error('Error:', message.error);
                break;
            }
        }
    }
    //#endregion ExperimentalClientTasks_requestStream
}
