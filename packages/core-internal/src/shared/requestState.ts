/**
 * The type of `ctx.mcpReq.requestState`. The type parameter is
 * caller-asserted (no validation, like the two-argument `acceptedContent<T>`)
 * — pair with `createRequestStateCodec<T>` so the claim is backed by the
 * codec's verification.
 */
export type RequestStateAccessor = <T = unknown>() => T | undefined;

/**
 * Builds the `ctx.mcpReq.requestState` accessor for a resolved value. The
 * `as T` below is the one place {@linkcode RequestStateAccessor}'s
 * caller-asserted typing is implemented — no implementation can produce an
 * arbitrary `T` from a runtime value honestly.
 */
export function requestStateAccessor(value: unknown): RequestStateAccessor {
    return <T>(): T | undefined => value as T | undefined;
}
