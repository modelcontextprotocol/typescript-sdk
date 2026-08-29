---
'@modelcontextprotocol/client': minor
---

Add WorkloadIdentityProvider implementing the SEP-1933 Workload Identity Federation jwt-bearer flow (extension io.modelcontextprotocol/auth/wif). MCP clients can now authenticate with platform-issued workload JWTs such as Kubernetes service account tokens and SPIFFE JWT-SVIDs, with no client secret and no dynamic client registration.
