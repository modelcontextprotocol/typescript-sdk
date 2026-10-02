/**
 * Server Card discovery example (experimental extension, SEP-2127): the
 * client is told only the domain. It probes the well-known AI Catalog,
 * validates the discovered card, resolves the remote, connects, calls a tool,
 * and reconciles the card's claims against the live serverInfo.
 *
 * HTTP only — run the sibling `server.ts --http --port <N>` first, then
 * `client.ts --http http://127.0.0.1:<N>/mcp`.
 */
import { check, parseExampleArgs } from '@mcp-examples/shared';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { discoverServerCards, reconcileServerCard, resolveRemote } from '@modelcontextprotocol/client/experimental/server-card';

const { transport, url } = parseExampleArgs();
if (transport !== 'http') {
    throw new Error('this story is HTTP-only; pass --http http://127.0.0.1:<port>/mcp');
}

// Only the ORIGIN goes in: discovery finds the /mcp endpoint from the domain's
// AI Catalog. The hardened defaults reject plain HTTP and private addresses,
// but the local-dev hosts (localhost, 127.0.0.1, [::1]) are always exempt.
const origin = new URL(url).origin;
const hits = await discoverServerCards(origin);
check.equal(hits.length, 1, `expected one discovered card from ${origin}`);
const hit = hits[0]!;
console.error(`[client] discovered ${hit.entry.identifier} (listed by ${hit.listingDomain}, hosted by ${hit.hostingDomain ?? 'inline'})`);
check.equal(hit.card.name, 'com.example/weather');

const remote = hit.card.remotes![0]!;
const resolved = resolveRemote(remote);
check.equal(resolved.url.href, new URL(url).href, 'card remote must resolve to the real endpoint');

const client = new Client({ name: 'server-card-discovery-client', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(resolved.url, { requestInit: { headers: resolved.headers } }));

const result = await client.callTool({ name: 'forecast', arguments: { city: 'Berlin' } });
check.deepEqual(result.content, [{ type: 'text', text: 'Sunny in Berlin' }]);

// Advisory reconciliation: runtime wins on any disagreement.
const mismatches = reconcileServerCard(hit.card, client.getServerVersion()!, { remote });
check.deepEqual(mismatches, [], 'card claims must match the live serverInfo');

console.error('[client] discovery, connection, and reconciliation all verified');
await client.close();
