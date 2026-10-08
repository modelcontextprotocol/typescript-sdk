/*
 * Zod schemas for the MCP Skills extension wire types (./types), authored
 * against modelcontextprotocol/ext-skills `specification/stable/skills.mdx`
 * (SEP-2640) at commit 167da6c. Adapted from typescript-sdk#2818.
 *
 * Objects are loose so `_meta` and fields added by later revisions pass
 * through. `resultType` is not declared: the 2026-07-28 codec stamps and
 * consumes it. The 512-entry / 16 MiB limits are a floor hosts must accept,
 * not a ceiling, so the schemas do not enforce them.
 *
 * Copyright (c) Model Context Protocol contributors
 */

import * as z from 'zod/v4';

import { ResourceSchema } from '../../types/schemas';
import { SKILL_DIGEST_PATTERN, SKILL_MANIFEST_FILENAME } from './types';

const metaSchema = z.record(z.string(), z.unknown());
const cacheFields = { ttlMs: z.number().int().nonnegative(), cacheScope: z.enum(['public', 'private']) };

/** `SkillsExtensionCapability` */
export const skillsExtensionCapabilitySchema = z.looseObject({ directoryRead: z.boolean().optional() });

/** `SkillResource` */
export const skillResourceSchema = z.looseObject({
    uri: z.string(),
    digest: z.string().regex(SKILL_DIGEST_PATTERN, 'digest must be "sha256:" followed by 64 lowercase hex characters'),
    size: z.number().int().nonnegative()
});

/** `SkillFrontmatter` */
export const skillFrontmatterSchema = z.looseObject({ name: z.string(), description: z.string() });

const MANIFEST_SUFFIX = `/${SKILL_MANIFEST_FILENAME}`;

/**
 * `Skill`, with the structural rules every entry must meet: `uri` names a
 * `SKILL.md`, its directory ends in `frontmatter.name`, and a static
 * `resources` lists that `SKILL.md` and only files under the skill.
 */
export const skillSchema = z
    .looseObject({
        uri: z.string(),
        frontmatter: skillFrontmatterSchema,
        resources: z.union([z.array(skillResourceSchema), z.literal('dynamic')])
    })
    .superRefine((skill, ctx) => {
        if (!skill.uri.endsWith(MANIFEST_SUFFIX)) {
            ctx.addIssue({ code: 'custom', path: ['uri'], message: `skill uri must name its ${SKILL_MANIFEST_FILENAME}` });
            return;
        }
        const root = skill.uri.slice(0, -MANIFEST_SUFFIX.length);
        if (root.slice(root.lastIndexOf('/') + 1) !== skill.frontmatter.name) {
            ctx.addIssue({ code: 'custom', path: ['uri'], message: 'the final skill path segment must equal frontmatter.name' });
        }
        if (skill.resources === 'dynamic') return;
        if (!skill.resources.some(resource => resource.uri === skill.uri)) {
            ctx.addIssue({ code: 'custom', path: ['resources'], message: `resources must list the skill's ${SKILL_MANIFEST_FILENAME}` });
        }
        for (const [index, resource] of skill.resources.entries()) {
            if (!resource.uri.startsWith(`${root}/`)) {
                ctx.addIssue({ code: 'custom', path: ['resources', index, 'uri'], message: 'resource is outside the skill directory' });
            }
        }
    });

/** `ListSkillsParams` */
export const listSkillsParamsSchema = z.looseObject({ cursor: z.string().optional(), _meta: metaSchema.optional() });

/** `ListSkillsResult` */
export const listSkillsResultSchema = z.looseObject({
    skills: z.array(skillSchema),
    nextCursor: z.string().optional(),
    ...cacheFields,
    _meta: metaSchema.optional()
});

/** `GetSkillParams` */
export const getSkillParamsSchema = z.looseObject({ uri: z.string(), _meta: metaSchema.optional() });

/** `GetSkillResult` */
export const getSkillResultSchema = z.looseObject({ skill: skillSchema, ...cacheFields, _meta: metaSchema.optional() });

/** `ReadResourceDirectoryParams` */
export const readResourceDirectoryParamsSchema = z.looseObject({
    uri: z.string(),
    cursor: z.string().optional(),
    _meta: metaSchema.optional()
});

/** `ReadResourceDirectoryResult` */
export const readResourceDirectoryResultSchema = z.looseObject({
    resources: z.array(ResourceSchema),
    nextCursor: z.string().optional(),
    _meta: metaSchema.optional()
});
