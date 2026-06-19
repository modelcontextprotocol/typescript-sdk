/**
 * Error classes thrown by the OAuth client flow ({@linkcode auth} and helpers).
 *
 * Each behavior change in the 2026-07-28 authorization requirements adds its
 * dedicated error class to this module so callers can `instanceof`-dispatch on
 * the failure mode without string-matching messages.
 */

/**
 * Base class for the OAuth-client-flow error family. Concrete subclasses are
 * added to this module alongside the SEP-2468/837/2207/2350/2352 behavior
 * changes that throw them, so callers can catch the whole family with a single
 * `instanceof OAuthClientFlowError` guard once those land.
 *
 * @remarks Nothing in the SDK throws this base class directly. In the release
 * that introduces it no subclass exists yet — the guard is a forward-compat
 * hook and will not match anything until the first behavior change ships.
 */
export class OAuthClientFlowError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}
