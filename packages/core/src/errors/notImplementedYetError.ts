/**
 * Marks a deliberately-open seam: code that is already wired into the message
 * flow but whose behavior lands with a later stage of the 2026-07-28 spec
 * implementation. Every throw site names what fills the gap in an adjacent
 * code comment, so `git grep NotImplementedYet` is the inventory of remaining
 * gaps; the implementation is complete when that grep comes back empty.
 *
 * Messages must stay wire-safe — transports may surface them in error
 * responses — so they describe the missing behavior generically and never
 * reference internal planning details.
 *
 * @internal
 */
export class NotImplementedYetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NotImplementedYetError';
    }
}
