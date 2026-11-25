/**
 * What went wrong in an Events (SEP-3415) request or subscription: the SEP's error vocabulary.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export type EventsErrorKind = 'invalidParams' | 'notFound' | 'forbidden' | 'resourceExhausted' | 'unsupported' | 'callbackEndpointError';

/** The JSON-RPC code of each {@linkcode EventsErrorKind}, as SEP-3415 assigns them. */
export const EVENTS_ERROR_CODES: Readonly<Record<EventsErrorKind, number>> = {
    invalidParams: -32_602,
    notFound: -32_023,
    forbidden: -32_024,
    resourceExhausted: -32_025,
    unsupported: -32_026,
    callbackEndpointError: -32_027
};
