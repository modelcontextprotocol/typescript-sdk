/**
 * Type-checked examples for the `serverCard/` client helpers.
 *
 * These examples are synced into JSDoc comments via the sync-snippets script.
 * Each function's region markers define the code snippet that appears in the docs.
 *
 * @module
 */

import { discoverServerCards, requiredRemoteInputs, resolveRemote } from './serverCard/index';

/**
 * Example: probing a domain and resolving the first discovered remote.
 */
async function discoverServerCards_probeDomain(promptUser: (inputs: unknown) => Promise<Record<string, string>>) {
    //#region discoverServerCards_probeDomain
    const hits = await discoverServerCards('example.com'); // [] when the domain has no catalog
    for (const hit of hits) {
        console.log(`${hit.entry.identifier}: listed by ${hit.listingDomain}, hosted by ${hit.hostingDomain ?? 'inline'}`);
    }
    const remote = hits[0]!.card.remotes![0]!;
    const inputs = await promptUser(requiredRemoteInputs(remote));
    const { url, headers } = resolveRemote(remote, inputs);
    //#endregion discoverServerCards_probeDomain
    return { url, headers };
}
