---
'@modelcontextprotocol/client': patch
---

Don't swallow fetch `TypeError` as CORS in non-browser environments. Network errors
(DNS resolution failure, connection refused, invalid URL) in Node.js and Cloudflare
Workers now propagate from OAuth discovery instead of being silently misattributed
to CORS and returning `undefined`. This surfaces the real error to callers rather
than masking it as "metadata not found."
