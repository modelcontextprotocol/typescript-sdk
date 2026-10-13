import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const catalog = JSON.parse(readFileSync(new URL('./rea-170-tools.json', import.meta.url), 'utf8'));
let calls = 0;

for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    let result;
    if (message.method === 'initialize') {
        result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'rea-catalog-fixture', version: '1.0.0' }
        };
    } else if (message.method === 'tools/list') {
        result = { ...catalog, ttlMs: 0 };
    } else if (message.method === 'tools/call' && message.params.name === 'close_binary') {
        calls += 1;
        const structuredContent = { result: calls === 2 ? 0 : null };
        result = { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
    } else {
        process.stdout.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`
        );
        continue;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
}
