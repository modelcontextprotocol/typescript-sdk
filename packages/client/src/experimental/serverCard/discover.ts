import type { AICatalogEntry, ServerCard } from '@modelcontextprotocol/core/experimental/server-card';
import { SERVER_CARD_MEDIA_TYPE } from '@modelcontextprotocol/core/experimental/server-card';

import { ServerCardError } from './errors';
import { DEFAULT_MAX_CATALOG_ENTRIES, fetchAICatalog, fetchServerCard, getAICatalogUrl, parseCardDocument } from './fetch';
import type { DiscoveryFetchOptions } from './guard';

/**
 * Options for {@link discoverServerCards}.
 */
export interface DiscoverServerCardsOptions extends DiscoveryFetchOptions {
    /**
     * Cap on the number of Server Card entries processed from the catalog.
     * Defaults to 100.
     */
    maxEntries?: number;

    /**
     * Called for each entry that fails (fetch error, invalid card, bad URL).
     * A failing entry is skipped; the walk never aborts on one entry.
     */
    onEntryError?: (error: ServerCardError, entry: AICatalogEntry) => void;
}

/**
 * One discovered Server Card with its listing-chain provenance for consent
 * UI: `listingDomain` is where the claim came from, `hostingDomain` is where
 * traffic would go. The two may differ, and the entry's identifier,
 * publisher, and trust manifest are self-asserted and unverified.
 *
 * Cards are advisory. Never use them for security or access-control
 * decisions, never auto-connect, and de-duplicate on `card.remotes[].url`,
 * never on names or catalog identifiers (both spoofable).
 */
export interface DiscoveredServerCard {
    /** The validated card. Advisory, unverified. */
    card: ServerCard;
    /** The catalog entry that listed it. Self-asserted data. */
    entry: AICatalogEntry;
    /** Final URL the catalog was fetched from. */
    catalogUrl: string;
    /** Host of `catalogUrl`: where the listing claim came from. */
    listingDomain: string;
    /** Final URL the card was fetched from. Undefined for inline entries. */
    cardUrl?: string;
    /** Host of `cardUrl`: where traffic would go. Undefined for inline entries. */
    hostingDomain?: string;
}

/**
 * Domain-level Server Card discovery: one background probe of
 * `https://{domain}/.well-known/ai-catalog.json`.
 *
 * Fetches the catalog, keeps entries whose `type` is
 * `application/mcp-server-card+json`, follows `url` entries with
 * {@link fetchServerCard}, and parses inline `data` entries with zero extra
 * fetches. A catalog 404 or 410 returns `[]`: absence is a cacheable miss,
 * not an error. Any other catalog failure throws. Per-entry failures invoke
 * `onEntryError` and skip the entry.
 *
 * Returns data only: no dedup, no persistence, no auto-connect. When to
 * probe, and what to do with hits, is host policy. The returned promise is
 * fire-and-forget friendly; never block a user request on it.
 *
 * @example
 * ```ts source="../serverCard.examples.ts#discoverServerCards_probeDomain"
 * const hits = await discoverServerCards('example.com'); // [] when the domain has no catalog
 * for (const hit of hits) {
 *     console.log(`${hit.entry.identifier}: listed by ${hit.listingDomain}, hosted by ${hit.hostingDomain ?? 'inline'}`);
 * }
 * const remote = hits[0]!.card.remotes![0]!;
 * const inputs = await promptUser(requiredRemoteInputs(remote));
 * const { url, headers } = resolveRemote(remote, inputs);
 * ```
 */
export async function discoverServerCards(
    domainOrUrl: string | URL,
    options: DiscoverServerCardsOptions = {}
): Promise<DiscoveredServerCard[]> {
    const catalogUrl = getAICatalogUrl(domainOrUrl);
    let fetched;
    try {
        fetched = await fetchAICatalog(catalogUrl, options);
    } catch (error) {
        if (error instanceof ServerCardError && error.code === 'http-error' && (error.status === 404 || error.status === 410)) {
            return [];
        }
        throw error;
    }
    if (fetched.notModified) {
        // Unreachable without a caller-supplied etag; discovery sends none.
        return [];
    }
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_CATALOG_ENTRIES;
    const cardEntries = fetched.catalog.entries.filter(entry => entry.type === SERVER_CARD_MEDIA_TYPE).slice(0, maxEntries);
    const listingDomain = new URL(fetched.url).host;

    const discovered: DiscoveredServerCard[] = [];
    for (const entry of cardEntries) {
        try {
            if (entry.url === undefined) {
                // Inline entry: same lenient ingestion, zero extra fetches.
                const card = parseCardDocument(entry.data, fetched.url);
                discovered.push({ card, entry, catalogUrl: fetched.url, listingDomain });
            } else {
                const result = await fetchServerCard(entry.url, options);
                if (result.notModified) {
                    continue;
                }
                discovered.push({
                    card: result.card,
                    entry,
                    catalogUrl: fetched.url,
                    listingDomain,
                    cardUrl: result.url,
                    hostingDomain: new URL(result.url).host
                });
            }
        } catch (error) {
            const entryError =
                error instanceof ServerCardError
                    ? error
                    : new ServerCardError('invalid-server-card', `Catalog entry ${entry.identifier} could not be processed`, {
                          cause: error
                      });
            options.onEntryError?.(entryError, entry);
        }
    }
    return discovered;
}
