/**
 * Console-compatible sink for local SDK diagnostics.
 *
 * This is separate from MCP protocol logging (`notifications/message`). Every method is
 * optional; diagnostics at an omitted level are discarded. Pass an adapter around a
 * structured logger when its methods do not already accept console-style arguments.
 */
export type SdkLogger = {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
};
