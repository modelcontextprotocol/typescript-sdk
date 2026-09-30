---
'@modelcontextprotocol/sdk': minor
---

The Streamable HTTP and SSE client transports, and the OAuth requests made by `auth()` and the exported OAuth helpers, now follow a redirect only when it stays within the origin of the request: the same scheme, host and port, or http to https on the same host with default ports.
Only redirects that keep the method are followed (307 and 308, or any redirect of a GET), at most five in a row, and not when the `Location` brings userinfo of its own. Any other redirect is not followed: the request fails with an error that names the target, the session is kept
and later messages still send; metadata discovery moves on to the next well-known URL. Redirects within the origin that keep the method (307 and 308, or any redirect of a GET) keep working, up to five in a row, and need no code changes. This relies on the runtime returning the
redirect response for `redirect: 'manual'`, as Node.js does; in browsers that response is opaque, so there a redirected request fails instead of being followed.

Setting `redirectPolicy: 'follow'` on a transport leaves redirects of its requests, including the OAuth requests it makes for `authProvider`, to the fetch implementation. Redirects that fetch follows are followed as before. A redirect response that fetch returns instead, as it
does with `requestInit.redirect: 'manual'`, is reported by an error that names the target, and metadata discovery moves on to the next well-known URL.
