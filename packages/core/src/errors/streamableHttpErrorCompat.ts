import type { SdkErrorCode } from './sdkErrors.js';
import { SdkError } from './sdkErrors.js';

/**
 * @deprecated Use {@linkcode SdkError}.
 *
 * Subclass thrown by the StreamableHTTP client transport for HTTP-level errors.
 * `instanceof StreamableHTTPError` and `instanceof SdkError` both match. Note that
 * `.code` is now the {@linkcode SdkErrorCode} (a `ClientHttp*` string), not the HTTP
 * status number as in v1; the status is available as `.status`.
 */
export class StreamableHTTPError extends SdkError {
    public readonly status: number | undefined;

    constructor(code: SdkErrorCode, message: string, data?: { status?: number } & Record<string, unknown>) {
        super(code, message, data);
        this.name = 'StreamableHTTPError';
        this.status = data?.status;
    }
}
