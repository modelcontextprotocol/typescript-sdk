import type { DeliveryMode } from '@modelcontextprotocol/core/ext/events';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/core-internal/public';

/**
 * No delivery mode the event type offers is usable by this client: webhook
 * needs the `webhook` option, and a forced `delivery` narrows the client to
 * that one mode.
 *
 * Experimental: Events (SEP-3415) is new; this API may change in a minor release.
 *
 * @experimental
 */
export class NoCompatibleDeliveryModeError extends SdkError {
    static {
        Object.defineProperty(this, 'mcpBrand', { value: 'mcp.NoCompatibleDeliveryModeError' });
    }

    readonly eventName: string;
    /** The modes the event type's descriptor lists. */
    readonly offered: readonly DeliveryMode[];
    /** The modes this client could use for the request. */
    readonly usable: readonly DeliveryMode[];

    constructor(eventName: string, offered: readonly DeliveryMode[], usable: readonly DeliveryMode[]) {
        super(
            SdkErrorCode.CapabilityNotSupported,
            `No delivery mode fits event type '${eventName}': the server offers ${offered.join(', ')}; this client can use ${usable.length > 0 ? usable.join(', ') : 'none'}`,
            { eventName, offered, usable }
        );
        this.name = 'NoCompatibleDeliveryModeError';
        this.eventName = eventName;
        this.offered = offered;
        this.usable = usable;
    }
}
