/*
 * Error taxonomy for the durable task engine.
 *
 * Adapted from avenceslau/durability, pinned at commit 78cb099 (v2.1.0):
 * `packages/durability/src/index.ts` — the error classes and the
 * `serializeError` / `isNonRetryable` helpers (there defined inside
 * `createDurability`; extracted to module scope here). Class names are
 * re-mapped to this engine's vocabulary (steps and tasks instead of durable
 * calls and named alarms).
 * https://github.com/avenceslau/durability
 */

/**
 * Marks a handler failure as terminal so it is persisted without another retry.
 *
 * Use this for permanent failures such as invalid input. Transient errors
 * should be thrown normally so the configured retry policy can handle them.
 *
 * Recognition is duck-typed by name ({@link isNonRetryable}), so the check
 * survives the executor RPC boundary and also honors `cloudflare:workflows`'
 * class of the same name.
 */
export class NonRetryableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NonRetryableError';
    }
}

/**
 * Error recorded when a `step.do` closure attempt exceeds its configured
 * timeout. The engine creates this error; step code does not throw it itself.
 * Timeout failures follow the step's retry policy.
 */
export class StepTimeoutError extends Error {
    constructor(stepKey: string, timeoutMs: number) {
        super(`Step "${stepKey}" timed out after ${timeoutMs}ms`);
        this.name = 'StepTimeoutError';
    }
}

/** Error persisted when retry-delay evaluation fails or produces an unsafe value. */
export class RetryPolicyError extends Error {
    constructor(entity: string, reason?: unknown) {
        super(`Retry policy for ${entity} must produce a non-negative safe-integer delay`);
        this.name = 'RetryPolicyError';
        if (reason !== undefined) {
            Object.defineProperty(this, 'cause', { value: reason });
        }
    }
}

/** Error persisted when a successful result cannot be JSON-serialized. */
export class ResultSerializationError extends Error {
    constructor(entity: string, reason?: unknown) {
        super(`Result for ${entity} is not JSON-serializable`);
        this.name = 'ResultSerializationError';
        if (reason !== undefined) {
            Object.defineProperty(this, 'cause', { value: reason });
        }
    }
}

/** Error persisted when pending work has already reached its attempt limit. */
export class AttemptsExhaustedError extends Error {
    constructor(entity: string, maxAttempts: number) {
        super(`${entity} exhausted its ${maxAttempts} attempts`);
        this.name = 'AttemptsExhaustedError';
    }
}

/**
 * Error thrown when a step name is reused within a single task.
 *
 * Step names are the journal keys (unique per task, decision D8): calling
 * `step.do` twice with one name in a single run is a hard error. Loops must
 * suffix an index.
 */
export class DuplicateStepError extends Error {
    constructor(stepKey: string) {
        super(
            `Step name "${stepKey}" was already used in this task. ` +
                `Step names are journal keys and must be unique per task; suffix an index for loops.`
        );
        this.name = 'DuplicateStepError';
    }
}

/** A thrown value reduced to a JSON-safe `{name, message}` pair. */
export interface SerializedError {
    name: string;
    message: string;
}

/**
 * Extracts `{name, message}` from an arbitrary thrown value, defending against
 * hostile getters — a throwing `name`/`message` accessor cannot break the
 * engine.
 */
export const serializeError = (error: unknown): SerializedError => {
    let name = 'Error';
    let message = 'Unknown thrown value';
    try {
        if (error === null) {
            return { name, message: 'null' };
        }
        if (typeof error !== 'object' && typeof error !== 'function') {
            return { name, message: String(error) };
        }
        try {
            const candidate = Reflect.get(error, 'name');
            if (typeof candidate === 'string' && candidate.length > 0) {
                name = candidate;
            }
        } catch {
            name = 'Error';
        }
        try {
            const candidate = Reflect.get(error, 'message');
            if (typeof candidate === 'string' && candidate.length > 0) {
                message = candidate;
            }
        } catch {
            message = 'Unknown thrown value';
        }
        return { name, message };
    } catch {
        return { name: 'Error', message: 'Unknown thrown value' };
    }
};

const isErrorInstance = (error: unknown, constructor: new (...args: never[]) => Error): boolean => {
    try {
        return error instanceof constructor;
    } catch {
        return false;
    }
};

/**
 * Duck-typed non-retryable check: recognizes this module's
 * {@link NonRetryableError}, any value whose `name` (or constructor name) is
 * `"NonRetryableError"` — which covers instances that crossed an RPC boundary
 * and `cloudflare:workflows`' class of the same name — while staying safe
 * against hostile getters.
 */
export const isNonRetryable = (error: unknown): boolean => {
    if (isErrorInstance(error, NonRetryableError)) {
        return true;
    }
    if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
        return false;
    }
    try {
        if (Reflect.get(error, 'name') === 'NonRetryableError') {
            return true;
        }
        const constructor = Reflect.get(error, 'constructor');
        return (
            constructor !== null &&
            (typeof constructor === 'object' || typeof constructor === 'function') &&
            Reflect.get(constructor, 'name') === 'NonRetryableError'
        );
    } catch {
        return false;
    }
};
