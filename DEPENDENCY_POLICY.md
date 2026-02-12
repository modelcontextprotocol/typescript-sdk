# Dependency Update Policy

This document describes how dependencies are managed in the MCP TypeScript SDK.

## Automated Updates

We use [Dependabot](https://docs.github.com/en/code-security/dependabot) to automatically monitor and propose dependency updates:

- **npm packages**: Checked weekly (Mondays). Patch and minor updates for dev dependencies are grouped into a single PR. Production dependency patches are grouped separately.
- **GitHub Actions**: Checked weekly (Mondays).

## Review Process

- All dependency update PRs must pass CI (lint, tests, build) before merging.
- Production dependency updates (minor or major) are reviewed manually for breaking changes and compatibility.
- Dev dependency groups (minor/patch) may be merged once CI passes without additional review.
- Major version bumps for any dependency require a maintainer review to assess breaking changes.

## Security Updates

- Dependabot security alerts are triaged as P0 and patched within 7 days.
- Security advisories are monitored via GitHub's built-in vulnerability alerts.

## Adding New Dependencies

Before adding a new dependency, consider:

- Is it actively maintained?
- Does it have a compatible license (MIT, Apache-2.0, BSD)?
- Can the functionality be achieved without adding a dependency?
- What is the impact on bundle size?

New production dependencies require maintainer approval.
