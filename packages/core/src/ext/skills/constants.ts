/**
 * Wire constants for the MCP Skills extension (SEP-2640).
 *
 * Runtime-neutral: this module and its siblings import nothing beyond `zod/v4`
 * and the core schema modules, so the extension stays consumable from browser
 * and Cloudflare Workers bundles.
 */

/**
 * The reverse-DNS identifier under which a server advertises the Skills
 * extension in `ServerCapabilities.extensions`.
 */
export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

/** Request method that enumerates the skills a server serves. */
export const SKILLS_LIST_METHOD = 'skills/list';

/** Request method that fetches a single skill entry by its `SKILL.md` URI. */
export const SKILLS_GET_METHOD = 'skills/get';

/** The canonical URI scheme for skills. Servers MAY serve skills under other schemes. */
export const SKILL_URI_SCHEME = 'skill:';

/** The manifest filename that terminates every `SKILL.md` URI. */
export const SKILL_MANIFEST_FILENAME = 'SKILL.md';

/**
 * Maximum number of resource entries in a single skill (SEP-2640 normative
 * limit). Hosts MUST support up to this many; servers SHOULD NOT exceed it.
 */
export const MAX_SKILL_RESOURCES = 512;

/**
 * Maximum total byte size of a single skill's files: 16 MiB (SEP-2640
 * normative limit). Checkable from a skill entry before any file is fetched.
 */
export const MAX_SKILL_TOTAL_BYTES = 16_777_216;

/**
 * The digest format required on every skill resource entry: lowercase
 * `sha256:` followed by 64 hex characters.
 */
export const SKILL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
