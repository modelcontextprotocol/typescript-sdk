/** Default upper bound, in bytes, on a request body read by the HTTP entry points (4 MiB). */
export const DEFAULT_MAX_REQUEST_BODY_SIZE = 4 * 1024 * 1024;

/** Upper bound on the number of messages accepted in one JSON-RPC batch array. */
export const MAX_BATCH_SIZE = 100;

/** The message answered with 413 for a request body over `maxBytes`. */
export function requestBodyTooLargeMessage(maxBytes: number): string {
    return `Payload Too Large: Request body must not exceed ${maxBytes} bytes`;
}

/**
 * Resolves a `maxRequestBodySize` option to the bound to apply: the default when
 * omitted, otherwise the value itself, which must be a positive finite number of
 * bytes (a `RangeError` is thrown at configuration time for anything else).
 */
export function resolveMaxRequestBodySize(value: number | undefined): number {
    if (value === undefined) {
        return DEFAULT_MAX_REQUEST_BODY_SIZE;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new RangeError(`maxRequestBodySize must be a positive number of bytes, got ${String(value)}`);
    }
    return value;
}

/**
 * Reads a request body as text, up to `maxBytes` (default
 * {@linkcode DEFAULT_MAX_REQUEST_BODY_SIZE}). A declared `Content-Length` over the
 * limit is refused without reading anything; otherwise the read stops as soon as
 * more than the limit has arrived. Stream failures propagate.
 */
export async function readRequestBody(
    request: Request,
    maxBytes: number = DEFAULT_MAX_REQUEST_BODY_SIZE
): Promise<{ tooLarge: true } | { tooLarge: false; text: string }> {
    if (Number(request.headers.get('content-length')) > maxBytes) {
        return { tooLarge: true };
    }
    if (request.body === null) {
        return { tooLarge: false, text: '' };
    }
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            received += value.byteLength;
            if (received > maxBytes) {
                return { tooLarge: true };
            }
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        reader.releaseLock();
    }
    return { tooLarge: false, text: text + decoder.decode() };
}
