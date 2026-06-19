/**
 * Connects to the routing fork as both a plain 2025 client (lands on the
 * existing sessionful transport, `era=legacy`) and a 2026-capable client
 * (lands on the strict modern entry, `era=modern`).
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { check, httpUrlFromArgs, runClient } from '../harness.js';

const URL = httpUrlFromArgs('http://127.0.0.1:3000/mcp');

runClient('legacy-routing', async () => {
    // 2025 client → routed to the existing sessionful deployment.
    const legacy = new Client({ name: 'legacy-routing-client', version: '1.0.0' });
    await legacy.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));
    const lr = await legacy.callTool({ name: 'greet', arguments: { name: 'A' } });
    check.match(lr.content?.[0]?.type === 'text' ? lr.content[0].text : '', /era=legacy/);
    await legacy.close();

    // 2026 client → routed to the strict modern entry.
    const modern = new Client({ name: 'legacy-routing-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await modern.connect(new StreamableHTTPClientTransport(new globalThis.URL(URL)));
    check.equal(modern.getNegotiatedProtocolVersion(), '2026-07-28');
    const mr = await modern.callTool({ name: 'greet', arguments: { name: 'B' } });
    check.match(mr.content?.[0]?.type === 'text' ? mr.content[0].text : '', /era=modern/);
    await modern.close();
});
