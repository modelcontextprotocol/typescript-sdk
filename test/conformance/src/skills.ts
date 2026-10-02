import { createHash } from 'node:crypto';

import type { McpServer, ReadResourceResult, ServerContext } from '@modelcontextprotocol/server';
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const SKILL_NAME = 'conformance-skill';
const SKILL_DESCRIPTION = 'A small skill served by the TypeScript SDK conformance fixture.';
const SKILL_ROOT_URI = `skill://${SKILL_NAME}`;
const SKILL_MANIFEST_URI = `${SKILL_ROOT_URI}/SKILL.md`;
const SKILL_REFERENCES_URI = `${SKILL_ROOT_URI}/references`;
const SKILL_GUIDE_URI = `${SKILL_REFERENCES_URI}/guide.md`;
const CACHE_TTL_MS = 60_000;

const SKILL_MANIFEST = `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
---

# Conformance skill

Use the supporting guide when exercising this fixture.
`;

const SKILL_GUIDE = `# Supporting guide

This file makes directory traversal observable to the conformance suite.
`;

const SkillResourceEntrySchema = z.looseObject({
    uri: z.string(),
    digest: z.string(),
    size: z.number().int().nonnegative()
});

const SkillEntrySchema = z.looseObject({
    uri: z.string(),
    frontmatter: z.looseObject({
        name: z.string(),
        description: z.string()
    }),
    resources: z.array(SkillResourceEntrySchema)
});

const SkillsListParamsSchema = z.looseObject({
    cursor: z.string().optional()
});

const SkillsListResultSchema = z.looseObject({
    skills: z.array(SkillEntrySchema),
    nextCursor: z.string().optional(),
    ttlMs: z.number().int().nonnegative().optional(),
    cacheScope: z.enum(['public', 'private']).optional()
});

const SkillsGetParamsSchema = z.looseObject({
    uri: z.string()
});

const SkillsGetResultSchema = z.looseObject({
    skill: SkillEntrySchema,
    ttlMs: z.number().int().nonnegative().optional(),
    cacheScope: z.enum(['public', 'private']).optional()
});

const DirectoryReadParamsSchema = z.looseObject({
    uri: z.string(),
    cursor: z.string().optional()
});

const DirectoryResourceSchema = z.looseObject({
    uri: z.string(),
    name: z.string(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().int().nonnegative().optional()
});

const DirectoryReadResultSchema = z.looseObject({
    resources: z.array(DirectoryResourceSchema),
    nextCursor: z.string().optional()
});

function resourceEntry(uri: string, contents: string) {
    const bytes = Buffer.from(contents);
    return {
        uri,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        size: bytes.byteLength
    };
}

const skillEntry = {
    uri: SKILL_MANIFEST_URI,
    frontmatter: {
        name: SKILL_NAME,
        description: SKILL_DESCRIPTION
    },
    resources: [resourceEntry(SKILL_MANIFEST_URI, SKILL_MANIFEST), resourceEntry(SKILL_GUIDE_URI, SKILL_GUIDE)]
};

function cacheAttributes(ctx: ServerContext): { ttlMs: number; cacheScope: 'public' } | Record<string, never> {
    const protocolVersion = ctx.mcpReq.envelope?.['io.modelcontextprotocol/protocolVersion'];
    return typeof protocolVersion === 'string' && protocolVersion >= '2026-07-28' ? { ttlMs: CACHE_TTL_MS, cacheScope: 'public' } : {};
}

/**
 * Registers the SEP-2640 surface used by the server conformance suite.
 *
 * This follows the same portable custom-method pattern as Olaservo's
 * `@olaservo/ext-skills` implementation: resources remain normal MCP
 * resources, while skills/list, skills/get, and resources/directory/read use
 * the SDK's typed custom request-handler API.
 */
export function registerSkillsConformanceFixture(mcpServer: McpServer): void {
    mcpServer.registerResource(
        SKILL_NAME,
        SKILL_MANIFEST_URI,
        {
            description: SKILL_DESCRIPTION,
            mimeType: 'text/markdown'
        },
        async (): Promise<ReadResourceResult> => ({
            contents: [
                {
                    uri: SKILL_MANIFEST_URI,
                    mimeType: 'text/markdown',
                    text: SKILL_MANIFEST
                }
            ]
        })
    );

    mcpServer.registerResource(
        'guide.md',
        SKILL_GUIDE_URI,
        {
            description: 'Supporting material for the conformance skill',
            mimeType: 'text/markdown'
        },
        async (): Promise<ReadResourceResult> => ({
            contents: [
                {
                    uri: SKILL_GUIDE_URI,
                    mimeType: 'text/markdown',
                    text: SKILL_GUIDE
                }
            ]
        })
    );

    mcpServer.server.setRequestHandler(
        'skills/list',
        { params: SkillsListParamsSchema, result: SkillsListResultSchema },
        async (_params, ctx) => ({
            skills: [skillEntry],
            ...cacheAttributes(ctx)
        })
    );

    mcpServer.server.setRequestHandler(
        'skills/get',
        { params: SkillsGetParamsSchema, result: SkillsGetResultSchema },
        async (params, ctx) => {
            if (params.uri !== SKILL_MANIFEST_URI) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill URI: ${params.uri}`);
            }
            return {
                skill: skillEntry,
                ...cacheAttributes(ctx)
            };
        }
    );

    mcpServer.server.setRequestHandler(
        'resources/directory/read',
        { params: DirectoryReadParamsSchema, result: DirectoryReadResultSchema },
        async params => {
            if (params.uri === SKILL_ROOT_URI) {
                return {
                    resources: [
                        {
                            uri: SKILL_MANIFEST_URI,
                            name: SKILL_NAME,
                            description: SKILL_DESCRIPTION,
                            mimeType: 'text/markdown',
                            size: Buffer.byteLength(SKILL_MANIFEST)
                        },
                        {
                            uri: SKILL_REFERENCES_URI,
                            name: 'references',
                            mimeType: 'inode/directory'
                        }
                    ]
                };
            }

            if (params.uri === SKILL_REFERENCES_URI) {
                return {
                    resources: [
                        {
                            uri: SKILL_GUIDE_URI,
                            name: 'guide.md',
                            description: 'Supporting material for the conformance skill',
                            mimeType: 'text/markdown',
                            size: Buffer.byteLength(SKILL_GUIDE)
                        }
                    ]
                };
            }

            throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Not a served skill directory: ${params.uri}`);
        }
    );
}
