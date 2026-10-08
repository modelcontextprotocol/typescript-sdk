/*
 * MCP Skills extension wire types (extension id: io.modelcontextprotocol/skills).
 *
 * Authored against modelcontextprotocol/ext-skills `specification/stable/skills.mdx`
 * (SEP-2640) at commit 167da6c, base revision 2026-07-28. Constants and
 * naming adapted from typescript-sdk#2818.
 * https://github.com/modelcontextprotocol/ext-skills
 *
 * Copyright (c) Model Context Protocol contributors
 */

import type { Resource, Result } from '../../types/index';

/** The MCP Skills extension identifier. */
export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

/** The file every skill has at its root; a skill is addressed by this file's URI. */
export const SKILL_MANIFEST_FILENAME = 'SKILL.md';

/** `mimeType` of a directory resource (`resources/directory/read`). */
export const DIRECTORY_MIME_TYPE = 'inode/directory';

/** Per-skill limit on `resources` entries, `SKILL.md` included. Hosts MUST accept up to this. */
export const MAX_SKILL_RESOURCES = 512;

/** Per-skill limit on the sum of `size` over `resources`: 16 MiB. Hosts MUST accept up to this. */
export const MAX_SKILL_TOTAL_BYTES = 16_777_216;

/** `sha256:` followed by 64 lowercase hex characters. */
export const SKILL_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Capability settings under `capabilities.extensions["io.modelcontextprotocol/skills"]`. `{}` declares support with no optional features. */
export interface SkillsExtensionCapability {
    /** The server implements `resources/directory/read`. Default `false`. */
    directoryRead?: boolean;
    [key: string]: unknown;
}

/** A file belonging to a skill, with the digest and size of its content. */
export interface SkillResource {
    /** Resource URI of the file. */
    uri: string;
    /** SHA-256 digest of the file's raw bytes, `sha256:{64 lowercase hex}`. */
    digest: string;
    /** Length in bytes of the file's raw content (the bytes `digest` covers). */
    size: number;
}

/** A skill's `SKILL.md` YAML frontmatter, verbatim as JSON. `name` and `description` are always present. */
export interface SkillFrontmatter {
    name: string;
    description: string;
    [key: string]: unknown;
}

/** The entry for one skill, returned by both `skills/list` and `skills/get`. */
export interface Skill {
    /** Resource URI of the skill's `SKILL.md`, readable via `resources/read`. */
    uri: string;
    /** The `SKILL.md` frontmatter, verbatim. */
    frontmatter: SkillFrontmatter;
    /** Every file of the skill (`SKILL.md` included), or `"dynamic"` when stable digests cannot be published. */
    resources: SkillResource[] | 'dynamic';
}

/** Where a cacheable result may be cached. */
export type SkillsCacheScope = 'public' | 'private';

/** `skills/list` params: standard list pagination. */
export interface ListSkillsParams {
    cursor?: string;
}

/** `skills/list` result. `ttlMs` and `cacheScope` are required, as on `resources/list`. */
export interface ListSkillsResult extends Result {
    skills: Skill[];
    nextCursor?: string;
    ttlMs: number;
    cacheScope: SkillsCacheScope;
}

/** `skills/get` params. */
export interface GetSkillParams {
    /** URI of the skill's `SKILL.md`. */
    uri: string;
}

/** `skills/get` result. `ttlMs` and `cacheScope` are required, as on `resources/read`. */
export interface GetSkillResult extends Result {
    skill: Skill;
    ttlMs: number;
    cacheScope: SkillsCacheScope;
}

/** `resources/directory/read` params. */
export interface ReadResourceDirectoryParams {
    /** URI of the directory resource, no trailing slash. */
    uri: string;
    cursor?: string;
}

/** `resources/directory/read` result: the directory's direct children. Subdirectories carry `mimeType: "inode/directory"`. */
export interface ReadResourceDirectoryResult extends Result {
    resources: Resource[];
    nextCursor?: string;
}
