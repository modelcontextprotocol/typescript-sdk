import { Client } from '../../client/index.js';
import { StreamableHTTPClientTransport } from '../../client/streamableHttp.js';
import { CallToolResultSchema } from '../../types.js';

const client = new Client({ name: 'disconnect-test-client', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

let progressCount = 0;

client.onerror = e => console.error('Client error:', e);

(async () => {
    await client.connect(transport);
    console.log('Connected, calling slow-task with steps=10...');

    try {
        const result = await client.request(
            { method: 'tools/call', params: { name: 'slow-task', arguments: { steps: 10 } } },
            CallToolResultSchema,
            {
                onprogress: progress => {
                    console.log(`Progress ${++progressCount}: ${progress.progress}/${progress.total}`);
                    if (progressCount === 5) {
                        console.log('Abruptly killing process after 5 progress updates...');
                        process.exit(1);
                    }
                }
            }
        );
        console.log('Result:', result);
    } catch (e) {
        console.log('Request aborted (expected):', (e as Error).message);
    }
})();
