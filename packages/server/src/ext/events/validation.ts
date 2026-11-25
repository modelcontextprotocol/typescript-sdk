import type { DeliveryMode } from '@modelcontextprotocol/core/ext/events';
import type { ServerContext } from '@modelcontextprotocol/core-internal';
import { canonicalJson, EventsError } from '@modelcontextprotocol/core-internal/ext/events';

import type { EventRegistry, RegisteredEvent } from './registry';
import type { EventsOptions } from './types';

// With `getPrincipal`, each principal, and the callers without one together, may hold this share of `maxSubscriptions`.
const PRINCIPAL_SHARE_DIVISOR = 4;
// The longest canonical JSON of a request's `arguments`, which bounds what a lease, a stream or a stored record keeps of them.
const MAX_ARGUMENTS_LENGTH = 65_536;

export interface ValidatorDeps {
    readonly registry: EventRegistry;
    readonly webhookEnabled: boolean;
    readonly getPrincipal: EventsOptions['getPrincipal'];
    readonly maxSubscriptions: number;
    // Subscriptions this process serves now: poll leases, push streams, and the webhook subscriptions whose subscribe or refresh it handled or is still creating.
    subscriptionCount(): number;
    // Those of them held by `principal` (`null`: the callers without one).
    principalSubscriptionCount(principal: string | null): number;
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

    // After the era gate in `setup`'s handlers: webhook mode (webhook only), principal (required for webhook), event exists, mode offered, the arguments' size, `beforeParse`, then the arguments.
    async validate(
        mode: DeliveryMode,
        params: SubscriptionRequest,
        ctx: ServerContext,
        beforeParse?: (principal: string | null, rawArgs: Record<string, unknown>) => void | Promise<void>
    ): Promise<ValidSubscription> {
        const webhook = mode === 'webhook';
        if (webhook && !this.#deps.webhookEnabled) throw notOffered('This server does not offer webhook delivery', mode);
        const principal = await this.principalOf(ctx);
        if (webhook && principal === null) throw new EventsError('forbidden', 'Webhook subscriptions need an authenticated principal');
        const entry = this.#deps.registry.require(params.name);
        if (!entry.modes(this.#deps.webhookEnabled).includes(mode)) {
            throw notOffered(`Event type ${params.name} does not offer ${mode} delivery`, mode);
        }
        const rawArgs = params.arguments ?? {};
        if (canonicalJson(rawArgs).length > MAX_ARGUMENTS_LENGTH) {
            throw new EventsError('invalidParams', `arguments must be at most ${MAX_ARGUMENTS_LENGTH} characters as canonical JSON`);
        }
        await beforeParse?.(principal, rawArgs);
        const args = await entry.parseArguments(rawArgs);
        return { entry, principal, args };
    }

    // Who the request is from, by `getPrincipal`; `null` without one.
    async principalOf(ctx: ServerContext): Promise<string | null> {
        return (await this.#deps.getPrincipal?.(ctx)) ?? null;
    }

    // The `maxSubscriptions` quota and, with `getPrincipal`, the principal's share of it; call it before a new subscription's `onSubscribe`.
    assertCapacity(principal: string | null): void {
        const max = this.#deps.maxSubscriptions;
        if (this.#deps.subscriptionCount() >= max) {
            throw new EventsError('resourceExhausted', 'Subscription limit reached', { limit: 'subscriptions', max });
        }
        // Without getPrincipal every caller is in one bucket, so a share would only shrink the quota.
        if (this.#deps.getPrincipal === undefined) return;
        const share = Math.max(1, Math.floor(max / PRINCIPAL_SHARE_DIVISOR));
        if (this.#deps.principalSubscriptionCount(principal) >= share) {
            throw new EventsError('resourceExhausted', 'Subscription limit for this principal reached', {
                limit: 'principalSubscriptions',
                max: share
            });
        }
    }
}
