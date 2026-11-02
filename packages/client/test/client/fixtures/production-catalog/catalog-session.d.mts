import type { CatalogTool } from './load-catalog.mjs';

export const changedOutputSchema: Record<string, unknown>;
export const recoveryOutput: { result: { open: false; receivingProbe: 'recovered' } };
export const malformedOutput: { result: string };

export function withChangedBinarySession(tools: CatalogTool[]): CatalogTool[];

export interface CatalogSession {
    setChanged(value: boolean): void;
    listedTools(): CatalogTool[];
    callResult(): {
        content: { type: string; text: string }[];
        structuredContent: unknown;
        isError: boolean;
    };
    calls(): number;
}

export function createCatalogSession(options: { tools: CatalogTool[]; structuredContent: unknown; mode?: string }): CatalogSession;

export function handleMessage(session: CatalogSession, message: unknown): unknown;
