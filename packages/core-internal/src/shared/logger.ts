/**
 * Logger used by SDK internals for diagnostics.
 */
export type SdkLogger = {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
};
