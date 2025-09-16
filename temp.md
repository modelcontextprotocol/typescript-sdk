## Motivation and Context
Fixes infinite OAuth loops when authorization servers reject credentials and throw 401 again immediately after successful authentication. The transport retries auth infinitely when the server returns 401 for already-authorized requests.

## How Has This Been Tested?
Tested with MCP servers that return 401 after successful OAuth completion. Verified circuit breaker stops infinite loops while allowing legitimate auth retries.

## Breaking Changes
None. Defensive fix that only affects infinite loop edge cases.

## Types of changes
- [x] Bug fix (non-breaking change which fixes an issue)

## Checklist
- [x] I have read the [MCP Documentation](https://modelcontextprotocol.io)
- [x] My code follows the repository's style guidelines
- [x] New and existing tests pass locally
- [x] I have added appropriate error handling

## Additional context
Uses per-transport boolean flag to detect AUTHORIZED → immediate 401 pattern. Throws clear error instead of infinite recursion.