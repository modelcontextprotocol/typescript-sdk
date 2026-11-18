import type { DeliveryMode } from '@modelcontextprotocol/core/ext/events';
import type { ServerContext } from '@modelcontextprotocol/core-internal';
import { EventsError } from '@modelcontextprotocol/core-internal/ext/events';

import { assertModernRequest } from './eraGate';
import type { EventRegistry, RegisteredEvent } from './registry';
import type { EventsOptions } from './types';

export interface ValidatorDeps {
    readonly registry: EventRegistry;
    readonly webhookEnabled: boolean;
    readonly getPrincipal: EventsOptions['getPrincipal'];
    readonly maxSubscriptions: number | undefined;
    // Subscriptions served now, across every delivery mode.
    subscriptionCount(): number;
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

    // Era gate, principal, event exists, mode offered, `beforeParse` (poll: a terminated lease), then the arguments.
    async validate(
        mode: DeliveryMode,
        params: SubscriptionRequest,
        ctx: ServerContext,
        beforeParse?: (principal: string | null, rawArgs: Record<string, unknown>) => void
    ): Promise<ValidSubscription> {
        assertModernRequest(ctx);
        const principal = (await this.#deps.getPrincipal?.(ctx)) ?? null;
        const entry = this.#deps.registry.require(params.name);
        if (!entry.modes(this.#deps.webhookEnabled).includes(mode)) {
            throw new EventsError('unsupported', `Event type ${params.name} does not offer ${mode} delivery`, {
                feature: 'deliveryMode',
                value: mode
            });
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
