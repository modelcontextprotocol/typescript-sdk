/** Upper bound, in bytes, on a request body read by the HTTP entry points. */
export const MAX_REQUEST_BODY_SIZE = 4 * 1024 * 1024;

/** Upper bound on the number of messages accepted in one JSON-RPC batch array. */
export const MAX_BATCH_SIZE = 100;

/** The message answered with 413 for a request body over {@linkcode MAX_REQUEST_BODY_SIZE}. */
export const REQUEST_BODY_TOO_LARGE_MESSAGE = `Payload Too Large: Request body must not exceed ${MAX_REQUEST_BODY_SIZE} bytes`;

/**
 * Reads a request body as text, up to {@linkcode MAX_REQUEST_BODY_SIZE}. A declared
 * `Content-Length` over the limit is refused without reading anything; otherwise
 * the read stops as soon as more than the limit has arrived. Stream failures
 * propagate.
 */
export async function readRequestBody(request: Request): Promise<{ tooLarge: true } | { tooLarge: false; text: string }> {
    if (Number(request.headers.get('content-length')) > MAX_REQUEST_BODY_SIZE) {
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
            if (received > MAX_REQUEST_BODY_SIZE) {
                return { tooLarge: true };
            }
            text += decoder.decode(value, { stream: true });
        }
    } finally {
        reader.releaseLock();
    }
    return { tooLarge: false, text: text + decoder.decode() };
}
