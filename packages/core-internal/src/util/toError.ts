// Returns an `Error` unchanged and wraps any other thrown value in one.
export function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}
