import path from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

type ToolLike = {
    name: string;
    description?: string | null;
    inputSchema: unknown;
};

export type QualifiedToolDefinition = {
    anthropicTool: Anthropic.Tool;
    originalToolName: string;
    qualifiedToolName: string;
    serverLabel: string;
};

export function sanitizeServerLabel(serverScriptPath: string): string {
    const fileName = path.basename(serverScriptPath, path.extname(serverScriptPath));
    const normalized = fileName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

    if (!normalized) {
        return 'server';
    }

    return /^[0-9]/.test(normalized) ? `server_${normalized}` : normalized;
}

export function createUniqueServerLabel(serverScriptPath: string, usedLabels: Set<string>): string {
    const baseLabel = sanitizeServerLabel(serverScriptPath);
    let candidate = baseLabel;
    let suffix = 2;

    while (usedLabels.has(candidate)) {
        candidate = `${baseLabel}_${suffix}`;
        suffix += 1;
    }

    usedLabels.add(candidate);
    return candidate;
}

export function buildQualifiedToolName(serverLabel: string, toolName: string): string {
    return `${serverLabel}__${toolName}`;
}

export function buildQualifiedToolDefinitions(
    serverLabel: string,
    tools: ToolLike[]
): QualifiedToolDefinition[] {
    return tools.map((tool) => {
        const qualifiedToolName = buildQualifiedToolName(serverLabel, tool.name);
        const descriptionPrefix = `[server:${serverLabel}] Original MCP tool: ${tool.name}.`;
        const description = tool.description
            ? `${descriptionPrefix} ${tool.description}`
            : descriptionPrefix;

        return {
            originalToolName: tool.name,
            qualifiedToolName,
            serverLabel,
            anthropicTool: {
                name: qualifiedToolName,
                description,
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema
            }
        };
    });
}
