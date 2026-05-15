// Fixture: responds to server/discover with a valid DiscoverResult.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        return;
    }
    if (msg.method === 'server/discover') {
        process.stdout.write(
            JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                    supportedVersions: ['2026-06-30'],
                    capabilities: { tools: {} },
                    serverInfo: { name: 'modern-fixture', version: '1.0.0' }
                }
            }) + '\n'
        );
    }
});
