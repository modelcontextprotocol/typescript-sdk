import type { DeliveryMode } from '@modelcontextprotocol/core/ext/events';
import type { ServerContext } from '@modelcontextprotocol/core-internal';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';

import type { EventRegistry, RegisteredEvent } from './registry';
import type { EventsOptions } from './types';

export interface ValidatorDeps {
    readonly registry: EventRegistry;
    readonly webhookEnabled: boolean;
    readonly getPrincipal: EventsOptions['getPrincipal'];
    readonly maxSubscriptions: number | undefined;
    // Subscriptions this process serves now: poll leases, push streams, and the webhook subscriptions whose subscribe or refresh it handled or is still creating.
    subscriptionCount(): number;
}

function notOffered(message: string, mode: DeliveryMode): EventsError {
    return new EventsError('unsupported', message, { feature: 'deliveryMode', value: mode });
}

export interface SubscriptionRequest {
    readonly name: string;
    readonly arguments?: Record<string, unknown>;
}

export interface ValidSubscription {
    readonly entry: RegisteredEvent;
    readonly principal: string | null;
    readonly args: Record<string, unknown>;
}

// The checks every subscription request shares, so poll, push and webhook do not repeat them.
export class SubscriptionValidator {
    readonly #deps: ValidatorDeps;

    constructor(deps: ValidatorDeps) {
        this.#deps = deps;
    }

    // After the era gate in `attach`: webhook mode (webhook only), principal (required for webhook), event exists, mode offered, `beforeParse`, then the arguments.
    async validate(
        mode: DeliveryMode,
        params: SubscriptionRequest,
        ctx: ServerContext,
        beforeParse?: (principal: string | null, rawArgs: Record<string, unknown>) => void
    ): Promise<ValidSubscription> {
        const webhook = mode === 'webhook';
        if (webhook && !this.#deps.webhookEnabled) throw notOffered('This server does not offer webhook delivery', mode);
        const principal = (await this.#deps.getPrincipal?.(ctx)) ?? null;
        if (webhook && principal === null) throw new EventsError('forbidden', 'Webhook subscriptions need an authenticated principal');
        const entry = this.#deps.registry.require(params.name);
        if (!entry.modes(this.#deps.webhookEnabled).includes(mode)) {
            throw notOffered(`Event type ${params.name} does not offer ${mode} delivery`, mode);
        }
        const rawArgs = params.arguments ?? {};
        beforeParse?.(principal, rawArgs);
        const args = await entry.parseArguments(rawArgs);
        return { entry, principal, args };
    }

    // The `maxSubscriptions` quota; call it before a new subscription's `onSubscribe`.
    assertCapacity(): void {
        const max = this.#deps.maxSubscriptions;
        if (max !== undefined && this.#deps.subscriptionCount() >= max) {
            throw new EventsError('resourceExhausted', 'Subscription limit reached', { limit: 'subscriptions', max });
        }
    }
}
