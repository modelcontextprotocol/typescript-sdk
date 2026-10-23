import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { Client } from '../../../src/client/index.js';
import { StreamableHTTPClientTransport } from '../../../src/client/streamableHttp.js';

const cleanup = process.argv[2];
assert.ok(['resolve', 'reject', 'deferred-reject', 'pending'].includes(cleanup));

const initializationError = new TypeError('Initialization fetch failed');
const cleanupError = new Error('Connection cleanup failed');
let initializeRequests = 0;
const transport = new StreamableHTTPClientTransport(new URL('https://example.test/mcp'), {
    fetch: async () => {
        initializeRequests++;
        throw initializationError;
    }
});
const client = new Client({ name: 'cleanup-regression', version: '1.0.0' });
const originalClose = client.close.bind(client);
let closeCalls = 0;
let finishCleanup: (() => void) | undefined;
client.close = async () => {
    closeCalls++;
    await originalClose();
    if (cleanup === 'pending') {
        await new Promise<void>(resolve => {
            finishCleanup = resolve;
        });
    }
    if (cleanup === 'deferred-reject') await setImmediate();
    if (cleanup === 'reject' || cleanup === 'deferred-reject') throw cleanupError;
};

await assert.rejects(client.connect(transport), error => error === initializationError);
assert.equal(initializeRequests, 1);
assert.equal(closeCalls, 1);
if (cleanup === 'pending') {
    assert.ok(finishCleanup, 'connect must reject without waiting for cleanup to finish');
    finishCleanup();
}
// Cross the unhandled-rejection checkpoint, including delayed cleanup failures.
await setImmediate();
await setImmediate();
process.stdout.write('Original initialization error preserved; cleanup rejection handled.\n');
