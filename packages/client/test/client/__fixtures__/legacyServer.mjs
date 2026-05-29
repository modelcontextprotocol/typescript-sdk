// Fixture: responds to server/discover with a JSON-RPC error (simulating a legacy server).
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
                error: { code: -32601, message: 'Method not found' }
            }) + '\n'
        );
    }
});
