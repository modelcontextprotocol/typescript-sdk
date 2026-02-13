# @modelcontextprotocol/core

## 2.0.0

### Patch Changes

- [#1363](https://github.com/modelcontextprotocol/typescript-sdk/pull/1363) [`0a75810`](https://github.com/modelcontextprotocol/typescript-sdk/commit/0a75810b26e24bae6b9cfb41e12ac770aeaa1da4) Thanks [@DevJanderson](https://github.com/DevJanderson)! - Fix ReDoS vulnerability in
  UriTemplate regex patterns (CVE-2026-0621)

- [#1486](https://github.com/modelcontextprotocol/typescript-sdk/pull/1486) [`65bbcea`](https://github.com/modelcontextprotocol/typescript-sdk/commit/65bbceab773277f056a9d3e385e7e7d8cef54f9b) Thanks [@localden](https://github.com/localden)! - Fix InMemoryTaskStore to enforce
  session isolation. Previously, sessionId was accepted but ignored on all TaskStore methods, allowing any session to enumerate, read, and mutate tasks created by other sessions. The store now persists sessionId at creation time and enforces ownership on all reads and writes.

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - remove deprecated .tool,
  .prompt, .resource method signatures

- [#1419](https://github.com/modelcontextprotocol/typescript-sdk/pull/1419) [`dcf708d`](https://github.com/modelcontextprotocol/typescript-sdk/commit/dcf708d892b7ca5f137c74109d42cdeb05e2ee3a) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - deprecated .tool, .prompt,
  .resource method removal
