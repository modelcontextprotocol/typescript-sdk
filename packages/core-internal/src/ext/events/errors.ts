import { ProtocolError } from '../../types/errors';
import type { EventsErrorKind } from './codes';
import { EVENTS_ERROR_CODES } from './codes';

function kindOf(code: number): EventsErrorKind | undefined {
    return (Object.keys(EVENTS_ERROR_CODES) as EventsErrorKind[]).find(kind => EVENTS_ERROR_CODES[kind] === code);
}

/**
 * An Events (SEP-3415) error. It crosses the wire as an error response, and inside
 * `notifications/events/error`, `notifications/events/terminated` and the webhook `terminated` body.
 *
 * Branch on {@linkcode EventsError.kind}: it is the API. The inherited `code` is the SEP's code for that kind.
 * `instanceof` checks are brand-matched and work across separately bundled copies of the SDK.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export class EventsError extends ProtocolError {
    static {
        Object.defineProperty(this, 'mcpBrand', { value: 'mcp.EventsError' });
    }

    constructor(kind: EventsErrorKind, message: string, data?: Record<string, unknown>) {
        super(EVENTS_ERROR_CODES[kind], message, data);
    }

    /** What went wrong. */
    get kind(): EventsErrorKind {
        return kindOf(this.code)!;
    }

    /**
     * The `EventsError` for a `ProtocolError` received from an `events/*` request, by its code;
     * `undefined` for a code outside the Events error table. Data that is not an object is dropped.
     */
    static fromProtocolError(error: ProtocolError): EventsError | undefined {
        const kind = kindOf(error.code);
        if (kind === undefined) return undefined;
        const { data } = error;
        const objectData =
            typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : undefined;
        return new EventsError(kind, error.message, objectData);
    }
}
