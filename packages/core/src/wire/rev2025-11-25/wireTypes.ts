/**
 * 2025-era WIRE-VIEW types: the anchor-exact 2025-11-25 shapes for the names
 * whose NEUTRAL public types deliberately follow the 2026-07-28 typing.
 *
 * This module is the visible home of the shared-tier ADJUDICATIONS that the
 * old `@ts-expect-error` affordances used to suppress (Q1 increment 2): each
 * override below names a field where the 2025 anchor and the neutral model
 * disagree, states which side the neutral model follows, and is pinned both
 * ways by the per-revision parity suite (spec.types.2025-11-25.test.ts
 * compares THESE types against the frozen anchor exactly — zero affordances).
 *
 * RUNTIME NOTE (Q10-L2): the 2025-era runtime schemas are BEHAVIOR-FROZEN
 * and deliberately stay tolerant-wider than these wire views where the
 * neutral typing is wider (e.g. `experimental` values accept any JSONObject
 * at parse). These types pin the WIRE-LEVEL shape contract against the
 * anchor; they do not narrow runtime acceptance.
 *
 * Adjudication ledger (neutral follows 2026 unless stated):
 * - `Tool.inputSchema`/`outputSchema` property values: 2025 wire `object`;
 *   neutral follows 2026 (`JSONValue`-capable open schema objects).
 * - capability blobs (`experimental`, `sampling`, `elicitation`, `tasks`,
 *   `logging`, `completions`): 2025 wire `object`; neutral `JSONObject`.
 * - `extensions` capability key: 2026-only; absent from the 2025 wire view.
 * - `CreateMessageRequestParams.metadata`: 2025 wire `object`; neutral
 *   `JSONObject`.
 * - `PromptArgument.title` / `PromptReference.title`: present on the 2025
 *   wire (BaseMetadata); the neutral schemas do not declare it and the
 *   strip-mode parse drops it (PRE-EXISTING runtime gap, recorded in the
 *   project baseline-bug log — do not silently change parse behavior here).
 */
import type {
    CallToolRequest,
    CancelTaskRequest,
    ClientCapabilities,
    CompleteRequest,
    CreateMessageRequest,
    CreateMessageRequestParams,
    ElicitRequest,
    GetPromptRequest,
    GetTaskPayloadRequest,
    GetTaskRequest,
    InitializeRequest,
    InitializeRequestParams,
    InitializeResult,
    ListPromptsRequest,
    ListResourcesRequest,
    ListResourceTemplatesRequest,
    ListRootsRequest,
    ListTasksRequest,
    ListToolsRequest,
    ListToolsResult,
    PingRequest,
    PromptArgument,
    PromptReference,
    ReadResourceRequest,
    ServerCapabilities,
    SetLevelRequest,
    SubscribeRequest,
    Tool,
    UnsubscribeRequest
} from '../../types/types.js';

/** The 2025 anchor types blob values as bare `object`. */
type ObjectMap = { [key: string]: object };

/**
 * Omit that survives loose (index-signature) source types: the plain `Omit`
 * collapses named keys into the index signature (`Pick<T, string>`), which
 * silently weakens the pins. Key-remapping preserves both.
 */
type OmitKnown<T, K extends PropertyKey> = { [P in keyof T as P extends K ? never : P]: T[P] };

/** 2025 wire shape of tool input/output schemas (property values are `object`). */
export type Wire2025ToolIOSchema = {
    $schema?: string;
    type: 'object';
    properties?: ObjectMap;
    required?: string[];
};

export type Wire2025Tool = OmitKnown<Tool, 'inputSchema' | 'outputSchema'> & {
    inputSchema: Wire2025ToolIOSchema;
    outputSchema?: Wire2025ToolIOSchema;
};

export type Wire2025ListToolsResult = OmitKnown<ListToolsResult, 'tools'> & { tools: Wire2025Tool[] };

export type Wire2025ClientCapabilities = OmitKnown<
    ClientCapabilities,
    'extensions' | 'experimental' | 'sampling' | 'elicitation' | 'tasks'
> & {
    experimental?: ObjectMap;
    sampling?: { context?: object; tools?: object };
    elicitation?: { form?: object; url?: object };
    tasks?: {
        list?: object;
        cancel?: object;
        requests?: { sampling?: { createMessage?: object }; elicitation?: { create?: object } };
    };
};

export type Wire2025ServerCapabilities = OmitKnown<
    ServerCapabilities,
    'extensions' | 'experimental' | 'logging' | 'completions' | 'tasks'
> & {
    experimental?: ObjectMap;
    logging?: object;
    completions?: object;
    tasks?: {
        list?: object;
        cancel?: object;
        requests?: { tools?: { call?: object } };
    };
};

export type Wire2025InitializeRequestParams = OmitKnown<InitializeRequestParams, 'capabilities'> & {
    capabilities: Wire2025ClientCapabilities;
};

export type Wire2025InitializeRequest = OmitKnown<InitializeRequest, 'params'> & { params: Wire2025InitializeRequestParams };

export type Wire2025InitializeResult = OmitKnown<InitializeResult, 'capabilities'> & { capabilities: Wire2025ServerCapabilities };

export type Wire2025CreateMessageRequestParams = OmitKnown<CreateMessageRequestParams, 'metadata' | 'tools'> & {
    metadata?: object;
    tools?: Wire2025Tool[];
};

export type Wire2025CreateMessageRequest = OmitKnown<CreateMessageRequest, 'params'> & { params: Wire2025CreateMessageRequestParams };

/** 2025 wire: `title` is a declared BaseMetadata member (the neutral schemas do not model it — see ledger above). */
export type Wire2025PromptArgument = PromptArgument & { title?: string };
export type Wire2025PromptReference = PromptReference & { title?: string };

/** The 2025 wire role unions with the adjudicated members substituted. */
export type Wire2025ClientRequestView =
    | PingRequest
    | Wire2025InitializeRequest
    | CompleteRequest
    | SetLevelRequest
    | GetPromptRequest
    | ListPromptsRequest
    | ListResourcesRequest
    | ListResourceTemplatesRequest
    | ReadResourceRequest
    | SubscribeRequest
    | UnsubscribeRequest
    | CallToolRequest
    | ListToolsRequest
    | GetTaskRequest
    | GetTaskPayloadRequest
    | ListTasksRequest
    | CancelTaskRequest;

export type Wire2025ServerRequestView =
    | PingRequest
    | Wire2025CreateMessageRequest
    | ElicitRequest
    | ListRootsRequest
    | GetTaskRequest
    | GetTaskPayloadRequest
    | ListTasksRequest
    | CancelTaskRequest;
