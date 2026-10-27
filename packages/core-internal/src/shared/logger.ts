/**
 * Console-compatible sink for local SDK diagnostics.
 *
 * This is separate from MCP protocol logging (`notifications/message`). Every method is
 * optional; diagnostics at an omitted level are discarded. `console` fits as-is; pass an
 * adapter around a structured logger when its methods do not accept console-style arguments.
 */
export type SdkLogger = {
    debug?(...args: unknown[]): void;
    warn?(...args: unknown[]): void;
};

/**
 * Wraps a user-supplied {@linkcode SdkLogger} so a diagnostic can never change an operation's
 * result: a `null` or `undefined` logger falls back to `console`, and anything a logger method
 * throws is swallowed. Store the result wherever a `logger` option is accepted.
 */
export function guardLogger(logger: SdkLogger | null | undefined): SdkLogger {
    const target = logger ?? console;
    return {
        debug: (...args) => {
            try {
                target.debug?.(...args);
            } catch {
                // A failing diagnostic sink must not fail the SDK call that emitted it.
            }
        },
        warn: (...args) => {
            try {
                target.warn?.(...args);
            } catch {
                // A failing diagnostic sink must not fail the SDK call that emitted it.
            }
        }
    };
}
