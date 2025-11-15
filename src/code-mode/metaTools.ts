import { z } from 'zod';

export const ServerSummarySchema = z.object({
    serverId: z.string(),
    description: z.string().optional()
});

export const ListMcpServersOutputSchema = z.object({
    servers: z.array(ServerSummarySchema)
});

export type ListMcpServersResult = z.infer<typeof ListMcpServersOutputSchema>;

export const ToolSummarySchema = z.object({
    serverId: z.string(),
    toolName: z.string(),
    description: z.string().optional()
});

export const ListToolNamesInputSchema = z.object({
    serverId: z.string()
});

export const ListToolNamesOutputSchema = z.object({
    tools: z.array(ToolSummarySchema)
});

export type ToolSummary = z.infer<typeof ToolSummarySchema>;
export type ListToolNamesResult = z.infer<typeof ListToolNamesOutputSchema>;

export const GetToolImplementationInputSchema = z.object({
    serverId: z.string(),
    toolName: z.string()
});

export const GetToolImplementationOutputSchema = z.object({
    serverId: z.string(),
    toolName: z.string(),
    signature: z.string(),
    description: z.string().optional(),
    annotations: z.record(z.unknown()).optional(),
    inputSchema: z.record(z.unknown()).optional(),
    outputSchema: z.record(z.unknown()).optional()
});

export type GetToolImplementationResult = z.infer<typeof GetToolImplementationOutputSchema>;

export const CallToolInputSchema = z.object({
    serverId: z.string(),
    toolName: z.string(),
    arguments: z.record(z.unknown()).optional()
});

export type CallToolInput = z.infer<typeof CallToolInputSchema>;
