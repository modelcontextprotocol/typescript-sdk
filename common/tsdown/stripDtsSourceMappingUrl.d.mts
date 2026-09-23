import type { Rolldown } from 'tsdown';

/**
 * tsdown `inputOptions` hook that removes the trailing `//# sourceMappingURL=` comment from the
 * emitted `.d.ts` / `.d.mts` / `.d.cts` chunks. See the implementation in
 * `./stripDtsSourceMappingUrl.mjs` for the full rationale (#2233).
 */
export function stripDtsSourceMappingUrl(options: Rolldown.InputOptions): void;
