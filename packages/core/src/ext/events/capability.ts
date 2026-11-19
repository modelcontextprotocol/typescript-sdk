import type { CapabilitiesWithExtensions } from '../skills/capability';
import { EVENTS_EXTENSION_ID } from './constants';
import { EventsCapabilitySchema } from './schemas';
import type { EventsCapability } from './types';

/**
 * Reads the Events extension capability out of a peer's advertised
 * capabilities, returning `undefined` when the peer does not advertise the
 * extension or advertises a malformed value.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export function eventsCapabilityOf(capabilities: CapabilitiesWithExtensions | undefined): EventsCapability | undefined {
    const declared = capabilities?.extensions?.[EVENTS_EXTENSION_ID];
    if (declared === undefined) {
        return undefined;
    }
    const parsed = EventsCapabilitySchema.safeParse(declared);
    return parsed.success ? parsed.data : undefined;
}
