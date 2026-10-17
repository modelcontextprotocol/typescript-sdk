// Internal helpers for the MCP Skills extension (SEP-2640), shared by the
// client and server packages. Not part of any public entry point.
export type { ParsedSkillMarkdown, SplitSkillMarkdown } from './frontmatter';
export { FrontmatterError, parseFrontmatterYaml, parseSkillMarkdown, splitFrontmatter } from './frontmatter';
