// @modelcontextprotocol/core-internal/ext/skills
//
// Internal helpers for the MCP Skills extension (SEP-2640), shared by the
// client and server packages. Not part of any public entry point, and not on
// core-internal's root barrel: import them from this subpath, so they (and the
// `@modelcontextprotocol/core/ext/skills` import in `entry.ts`) stay out of the
// client and server root module graphs.
export { decodeBase64, decodeUtf8Lossless, encodeBase64, encodeUtf8, sha256Digest } from './bytes';
export type { SkillFileInput } from './entry';
export { buildSkillEntry, SKILL_NAME_PATTERN, skillEntryProblems, validateSkillEntry } from './entry';
export type { ParsedSkillMarkdown, SplitSkillMarkdown } from './frontmatter';
export { FrontmatterError, parseFrontmatterYaml, parseSkillMarkdown, splitFrontmatter } from './frontmatter';
export { mimeTypeFor } from './mime';
export {
    canonicalUri,
    compareUris,
    encodeSegment,
    isRoundTripUri,
    isWithin,
    joinUri,
    lastSegmentOf,
    resolveSkillRef,
    skillFileKey,
    skillRootUri,
    trimTrailingSlashes
} from './uri';
