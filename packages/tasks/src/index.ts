/**
 * `@modelcontextprotocol/tasks` — server-side MCP Tasks extension
 * (`io.modelcontextprotocol/tasks`) with a pluggable execution engine.
 *
 * Two seams keep handlers engine-invariant:
 *
 * - the control seam ({@link TaskEngine}): create / get / update / cancel,
 *   called by the `tasks/*` request handlers and the task tool;
 * - the step seam ({@link StepJournal}): what the replay-aware {@link Step}
 *   API drives while a handler runs.
 *
 * {@link InMemoryTaskEngine} is the reference engine. Durable engines
 * (a database plus workers, a durable-execution runtime) implement the same
 * two interfaces and live outside this package.
 */

export { DEFAULT_POLL_INTERVAL_MS, DEFAULT_RETRY_POLICY, DEFAULT_STEP_TIMEOUT_MS, DEFAULT_TTL_MS } from './engine/defaults';
export type { DurationString, DurationUnit } from './engine/duration';
export { parseDuration } from './engine/duration';
export type { SerializedError } from './engine/errors';
export {
    AttemptsExhaustedError,
    DuplicateStepError,
    isNonRetryable,
    NonRetryableError,
    ResultSerializationError,
    RetryPolicyError,
    serializeError,
    StepTimeoutError
} from './engine/errors';
export type { TaskRegistry } from './engine/executor';
export { createTaskExecutor } from './engine/executor';
export type { InMemoryTaskEngineOptions } from './engine/inMemory';
export { InMemoryTaskEngine } from './engine/inMemory';
export type {
    BeginStepOptions,
    BeginStepResult,
    CheckInputState,
    ElicitState,
    RunOutcome,
    SleepState,
    StepFailureDisposition,
    StepJournal,
    TaskExecutor,
    TaskInvocation
} from './engine/protocol';
export { isStaleLeaseError, StaleLeaseError } from './engine/protocol';
export type { CreateTaskParams, TaskAccess, TaskEngine } from './engine/taskEngine';
export type { InstallTasksOptions, Tasks } from './server/installTasks';
export { installTasks } from './server/installTasks';
export type { RegisteredTask, TaskConfig, TaskHandler, TaskInput, TaskRegistration } from './server/registration';
export { ReplayStep, SuspendSignal } from './step/replayStep';
export type { ElicitConfig, ElicitOutcome, JsonSerializable, RetryPolicy, Step, StepConfig } from './step/types';
export {
    cancelledTaskSchema,
    cancelTaskParamsSchema,
    cancelTaskRequestSchema,
    cancelTaskResultSchema,
    completedTaskSchema,
    createTaskResultSchema,
    detailedTaskSchema,
    failedTaskSchema,
    getTaskParamsSchema,
    getTaskRequestSchema,
    getTaskResultSchema,
    inputRequestSchema,
    inputRequestsSchema,
    inputRequiredTaskSchema,
    inputResponseSchema,
    inputResponsesSchema,
    taskSchema,
    tasksExtensionCapabilitySchema,
    taskStatusSchema,
    updateTaskParamsSchema,
    updateTaskRequestSchema,
    updateTaskResultSchema,
    workingTaskSchema
} from './wire/schemas';
export type {
    CancelledTask,
    CancelTaskParams,
    CancelTaskRequest,
    CancelTaskResult,
    CompletedTask,
    CreateTaskResult,
    DetailedTask,
    FailedTask,
    GetTaskParams,
    GetTaskRequest,
    GetTaskResult,
    InputRequest,
    InputRequests,
    InputRequiredTask,
    InputResponse,
    InputResponses,
    Task,
    TasksExtensionCapability,
    TaskStatus,
    UpdateTaskParams,
    UpdateTaskRequest,
    UpdateTaskResult,
    WorkingTask
} from './wire/types';
export { TASK_STATUSES, TASKS_EXTENSION_ID } from './wire/types';
