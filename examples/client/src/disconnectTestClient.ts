import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'disconnect-test-client', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3000/mcp'));

let progressCount = 0;

client.onerror = e => console.error('Client error:', e);

await client.connect(transport);
console.log('Connected, calling slow-task with steps=10...');

try {
    const result = await client.callTool(
        { name: 'slow-task', arguments: { steps: 10 } },
        {
            onprogress: ({ progress, total }: { progress: number; total?: number }) => {
                console.log(`Progress ${++progressCount}: ${progress}/${total}`);
                if (progressCount === 5) {
                    console.log('Abruptly killing process after 5 progress updates...');
                    throw new Error('Abruptly stopping after 5 progress updates');
                }
            }
        }
    );
    console.log('Result:', result);
} catch (error) {
    console.log('Request aborted (expected):', (error as Error).message);
}
