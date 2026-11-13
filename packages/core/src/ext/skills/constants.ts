/**
 * Wire constants for the MCP Skills extension (SEP-2640).
 *
 * Runtime-neutral: this module imports nothing.
 */

/** The identifier a server advertises in `ServerCapabilities.extensions`. */
export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

/** Enumerates the skills a server serves. */
export const SKILLS_LIST_METHOD = 'skills/list';

/** Returns one skill's entry by its `SKILL.md` URI, listed or not. */
export const SKILLS_GET_METHOD = 'skills/get';

/** Lists the direct children of a directory resource (gated by `directoryRead`). */
export const RESOURCES_DIRECTORY_READ_METHOD = 'resources/directory/read';

/** The `mimeType` of a directory resource. */
export const DIRECTORY_MIME_TYPE = 'inode/directory';

/**
 * Per-skill interoperability limits. Hosts MUST accept skills up to these;
 * servers SHOULD NOT publish skills over them.
 */
export const SKILL_LIMITS: Readonly<{ files: number; bytes: number }> = Object.freeze({ files: 512, bytes: 16_777_216 });

/** `sha256:` followed by 64 lowercase hexadecimal characters. */
export const SKILL_DIGEST_PATTERN = /^sha256:[\da-f]{64}$/;
