import type { CallToolResult, StandardSchemaWithJSON, ToolAnnotations } from '../../../index';
import type { RetryPolicy, Step } from '../step/types';

/** The validated input type a task handler receives for its input schema. */
export type TaskInput<In> = In extends StandardSchemaWithJSON<unknown, infer Output> ? Output : undefined;

/**
 * A task handler: receives the validated tool input and the replay-aware
 * {@link Step} API, and returns the `CallToolResult` that `tasks/get` will
 * inline once the task completes. A throwing handler completes the task with
 * an `isError: true` result (`failed` is reserved for engine errors).
 */
export type TaskHandler<In extends StandardSchemaWithJSON | undefined = undefined> = (
    input: TaskInput<In>,
    step: Step
) => Promise<CallToolResult>;

/** Configuration for `registerTask`. */
export interface TaskConfig<In extends StandardSchemaWithJSON | undefined = undefined> {
    title?: string;
    description?: string;
    /** zod v4 object (or any Standard Schema with JSON), same as `registerTool`. */
    inputSchema?: In;
    annotations?: ToolAnnotations;
    /**
     * Forbidden: an `outputSchema` breaks the `CreateTaskResult` wire path
     * (the tool answers a task handle, not a structured result). Enforced at
     * compile time (`never`) and at runtime.
     */
    outputSchema?: never;
    /** Task retention from creation, ms; `null` = unlimited. Default 86_400_000 (24h). */
    ttlMs?: number | null;
    /** Suggested client polling interval, ms. Default 5_000. */
    pollIntervalMs?: number;
    /** Default step retry policy for this task. */
    retries?: RetryPolicy;
}

/** Handle returned by `registerTask`. */
export interface RegisteredTask {
    enable(): void;
    disable(): void;
    remove(): void;
}

/** @internal Type-erased handler stored in the registration table. */
export type AnyTaskHandler = (input: unknown, step: Step) => Promise<CallToolResult>;

/** A resolved task registration (defaults applied). */
export interface TaskRegistration {
    name: string;
    ttlMs: number | null;
    pollIntervalMs: number;
    retries: Required<RetryPolicy>;
    inputSchema: StandardSchemaWithJSON | undefined;
    handler: AnyTaskHandler;
}
