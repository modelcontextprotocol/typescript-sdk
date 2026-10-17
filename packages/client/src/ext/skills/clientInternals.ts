import type { Client } from '../../client/client';

/** Mirrors `DEFAULT_LIST_MAX_PAGES` in `client/client.ts`. */
const DEFAULT_LIST_MAX_PAGES = 64;

interface ClientPrivates {
    _enforceStrictCapabilities?: boolean;
    _listMaxPages?: number;
}

/**
 * The two Client settings the skills client follows. Client keeps them
 * private; this reads them by name, and `clientInternals.test.ts` fails if
 * they are renamed.
 */
export function clientSettings(client: Client): { enforceStrictCapabilities: boolean; listMaxPages: number } {
    const privates = client as unknown as ClientPrivates;
    return {
        enforceStrictCapabilities: privates._enforceStrictCapabilities ?? false,
        listMaxPages: privates._listMaxPages ?? DEFAULT_LIST_MAX_PAGES
    };
}
