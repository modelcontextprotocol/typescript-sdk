# Roadmap

This document tracks the MCP TypeScript SDK's planned work and progress toward full spec compliance.

## Current Status

- **SDK Version**: 1.26.0 (stable)
- **Spec Version Tracked**: 2025-06-18 (latest stable)
- **Tier**: Assessed against SEP-1730 SDK Tiering System

## Active Work

### Spec Tracking

The SDK tracks the MCP specification and aims to release updates within 30 days of each spec release. Current spec coverage:

- **Core protocol**: Full support for tools, resources, prompts, sampling, elicitation, roots, logging, completions, and ping.
- **Transports**: Streamable HTTP (client + server), legacy SSE (client + server), stdio (client + server).
- **Protocol features**: Progress notifications, cancellation, pagination, capability negotiation, protocol version negotiation.
- **Auth**: OAuth 2.1 with PKCE, metadata discovery, scope handling, token endpoint auth methods.
- **Experimental**: Tasks API (get, list, cancel, result, status notifications).

### Conformance

- Server conformance: 100% pass rate (30/30 scenarios)
- Client conformance: 94.7% pass rate (18/19 scenarios)
- Gap: `auth/pre-registration` client scenario not yet implemented

### Documentation

- 34/48 non-experimental features fully documented with examples
- 8 features documented but missing runnable examples
- 6 features not yet documented

## Planned Work

### Near-Term

1. **Complete client conformance** — Implement `auth/pre-registration` scenario to reach 100%.
2. **Documentation gaps** — Document remaining 14 features with examples (tools change notifications, prompts embedded resources/image content/change notifications, roots change notifications, logging set level, resource templates, subscribing/unsubscribing, completions, ping,
   stdio transports).
3. **P0 triage** — Audit open P0-labeled issues and re-triage mislabeled items.

### Ongoing

- Track new MCP spec releases and update the SDK within 30 days.
- Maintain conformance test pass rates at or above current levels.
- Respond to bug reports within the triage SLA (2 business days).

## Tier 1 Targets

| Requirement        | Current   | Target    | Status               |
| ------------------ | --------- | --------- | -------------------- |
| Server conformance | 100%      | 100%      | Done                 |
| Client conformance | 94.7%     | 100%      | In progress          |
| Issue triage       | 96.9%     | >= 90%    | Done                 |
| P0 resolution      | 5 open    | 0 open    | Needs triage audit   |
| Documentation      | 34/48     | 48/48     | In progress          |
| Dependency policy  | Published | Published | Done                 |
| Roadmap            | Published | Published | Done (this document) |
| Versioning policy  | Published | Published | Done                 |
