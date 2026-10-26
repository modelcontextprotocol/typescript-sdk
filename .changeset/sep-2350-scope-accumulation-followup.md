---
'@modelcontextprotocol/client': patch
---

Add `OAuthClientProvider.includePreviouslyGrantedScopes`: when `true`, a new authorization started because a refresh was refused also requests the scope the dropped tokens held, so permissions granted earlier through step-up survive. See [Keep earlier scopes when a refresh is refused](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/oauth.md#keep-earlier-scopes-when-a-refresh-is-refused).
