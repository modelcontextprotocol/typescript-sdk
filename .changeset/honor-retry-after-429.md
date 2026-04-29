---
'@modelcontextprotocol/client': minor
'@modelcontextprotocol/core': patch
---

Honor `Retry-After` on HTTP 429 responses in `StreamableHTTPClientTransport`. Both POST and GET paths now parse `Retry-After` (delta-seconds and HTTP-date per RFC 7231 §7.1.3), sleep for the indicated duration, and retry up to a configurable max. New `rateLimitOptions` transport option exposes `maxRetries` (default 3), `defaultRetryAfterMs` (default 1s) for missing/garbage headers, and `maxRetryAfterMs` (default 60s) cap. Sleep honors the existing `AbortController` so `transport.close()` cancels in-flight waits. After the cap is hit, throws a new typed `SdkErrorCode.ClientHttpRateLimited` with the parsed `Retry-After` value attached to `error.data`.
