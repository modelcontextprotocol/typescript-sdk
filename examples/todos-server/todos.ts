/**
 * The "todos" demo application — the workload cli-client connects to out of the box.
 *
 * It is a small but believable application (a project todo board) where every MCP feature has
 * a job: CRUD tools the model calls from chat, the board and each task exposed as resources,
 * planning/seeding prompts, a sampling-backed `prioritize` tool that borrows the *host's*
 * model, elicitation-confirmed `clear_done` and `brainstorm_tasks`, and logging/progress while
 * it works. State is in-memory and per-process; the point is the wiring, not the persistence.
 * The transport entry point that serves this over stdio / Streamable HTTP is ../server.ts.
 */
import type {
    CallToolResult,
    ElicitRequestFormParams,
    InputRequiredResult,
    McpRequestContext,
    ServerContext
} from '@modelcontextprotocol/server';
import {
    acceptedContent,
    completable,
    createRequestStateCodec,
    inputRequired,
    McpServer,
    ResourceTemplate
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

/**
 * The brainstorm_tasks flow as an explicit state machine: each variant names the round the
 * handler is waiting on and carries exactly the data the next round needs. The handler
 * dispatches on `step`, not on which `inputResponses` key happens to be present.
 */
type BrainstormState =
    | { step: 'awaiting-count' }
    | { step: 'awaiting-custom-count'; topic: string }
    | { step: 'awaiting-ideas'; topic: string; count: number };

/**
 * HMAC-signs the `requestState` round-tripped through brainstorm_tasks' multi-round flow so a
 * client cannot forge or mutate the carried step/theme/count. The seam runs `verify` before the
 * handler (rejecting tampered state with -32602); the handler calls `verify` again to decode.
 * The key comes from the environment for real deployments and falls back to a per-process
 * random one for the zero-setup demo (which is fine because one process serves every round).
 */
const stateCodec = createRequestStateCodec<BrainstormState>({
    key: process.env.REQUEST_STATE_SECRET ?? crypto.getRandomValues(new Uint8Array(32))
});

/** Read the `action` from a raw elicitation `inputResponses` entry (decline/cancel detection). */
function elicitAction(response: unknown): 'accept' | 'decline' | 'cancel' {
    const action = typeof response === 'object' && response !== null && 'action' in response ? response.action : undefined;
    return action === 'accept' || action === 'decline' ? action : 'cancel';
}

/** Read the text content from a raw sampling (`createMessage`) `inputResponses` entry. */
function sampledText(response: unknown): string {
    const content = typeof response === 'object' && response !== null && 'content' in response ? response.content : undefined;
    return typeof content === 'object' && content !== null && 'type' in content && content.type === 'text' && 'text' in content
        ? String(content.text)
        : '';
}

interface Task {
    id: string;
    title: string;
    project: string;
    priority?: 'high' | 'medium' | 'low';
    due?: string;
    notes?: string;
    status: 'open' | 'done';
}

let nextId = 1;
const tasks = new Map<string, Task>();

function addTask(task: Omit<Task, 'id' | 'status'>): Task {
    const created: Task = { id: `t${nextId++}`, status: 'open', ...task };
    tasks.set(created.id, created);
    return created;
}

function openTasks(): Task[] {
    return [...tasks.values()].filter(task => task.status === 'open');
}

function projects(): string[] {
    return [...new Set([...tasks.values()].map(task => task.project))];
}

function describeTask(task: Task): string {
    const details = [task.priority && `priority: ${task.priority}`, task.due && `due: ${task.due}`, task.notes].filter(Boolean).join(', ');
    return `- [${task.status === 'done' ? 'x' : ' '}] ${task.title} (${task.id}, ${task.project}${details ? `; ${details}` : ''})`;
}

function renderBoard(): string {
    const done = [...tasks.values()].filter(task => task.status === 'done');
    return [
        '# Todo board',
        '',
        '## Open',
        ...openTasks().map(task => describeTask(task)),
        '',
        '## Done',
        ...done.map(task => describeTask(task))
    ].join('\n');
}

async function logInfo(ctx: ServerContext, text: string): Promise<void> {
    // Request-tied logging: honours the client's logging/setLevel threshold on 2025-era
    // connections and the per-request logLevel opt-in on 2026-07-28 connections.
    await ctx.mcpReq.log('info', text, 'todos');
}

/**
 * Over per-request HTTP serving, instance-level notifications have nowhere to go —
 * cross-request events are published through the handler's notifier instead. The transport
 * entry (../server.ts) wires these up for the HTTP branch; over stdio they stay unset and the
 * pinned instance's own notifications are routed by the serving entry.
 */
let publishBoardChanged: (() => void) | undefined;
let publishBoardUpdated: ((uri: string) => void) | undefined;

export function onBoardChanged(publish: () => void): void {
    publishBoardChanged = publish;
}

export function onBoardUpdated(publish: (uri: string) => void): void {
    publishBoardUpdated = publish;
}

async function reportProgress(ctx: ServerContext, progress: number, total: number, message: string): Promise<void> {
    const progressToken = ctx.mcpReq._meta?.progressToken;
    if (progressToken === undefined) return;
    await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress, total, message } });
}

const CLEAR_CONFIRM_SCHEMA: ElicitRequestFormParams['requestedSchema'] = {
    type: 'object',
    properties: {
        confirm: { type: 'boolean', title: 'Delete all completed tasks?', description: 'This cannot be undone.' }
    },
    required: ['confirm']
};

const BRAINSTORM_COUNT_SCHEMA: ElicitRequestFormParams['requestedSchema'] = {
    type: 'object',
    properties: {
        theme: { type: 'string', title: 'Theme for the invented tasks', default: "an engineer's week in hell" },
        count: { type: 'string', title: 'How many tasks should I invent?', enum: ['5', '10', '20', '50', 'custom'] }
    },
    required: ['count']
};

const BRAINSTORM_CUSTOM_COUNT_SCHEMA: ElicitRequestFormParams['requestedSchema'] = {
    type: 'object',
    properties: {
        customCount: { type: 'integer', title: 'Custom amount', minimum: 1, maximum: 100 }
    },
    required: ['customCount']
};

function buildBrainstormSampling(topic: string, wanted: number) {
    return {
        systemPrompt:
            'You invent short, funny todo items for a given theme. For engineering-flavored themes, lean into in-jokes like ' +
            '"Migrate the galactron database to omegastar" or "Ensure the tiddlywinks service speaks gRPC". ' +
            'Reply with one task per line, no numbering, no commentary.',
        messages: [
            {
                role: 'user' as const,
                content: { type: 'text' as const, text: `Invent ${wanted} todo tasks for the theme "${topic}".` }
            }
        ],
        maxTokens: Math.min(200 + wanted * 40, 1500)
    };
}

/** What the server claims to be doing while it "works through" a task — pure colour for the log stream. */
const WORK_QUIPS = [
    'applying percussive maintenance',
    'turning it off and on again',
    'blaming DNS first, investigating second',
    'negotiating with the load balancer',
    'consulting the rubber duck for a second opinion',
    'writing the postmortem in advance to save time',
    'adding a TODO to remove the TODO',
    'rolling back the rollback'
];

/** Parse an elicited count value (a preset like "10" or a custom number) into a usable number. */
function parseBrainstormCount(raw: unknown): number | undefined {
    const count = Number.parseInt(String(raw), 10);
    return Number.isNaN(count) || count < 1 || count > 100 ? undefined : count;
}

/** Match the LLM's ranking (one title per line) back to tasks; unmentioned tasks keep their order at the end. */
function applyRanking(rankingText: string, candidates: Task[]): Task[] {
    const remaining = [...candidates];
    const ranked: Task[] = [];
    for (const line of rankingText.split('\n')) {
        const normalized = line.toLowerCase();
        const index = remaining.findIndex(task => normalized.includes(task.title.toLowerCase()));
        if (index !== -1) ranked.push(...remaining.splice(index, 1));
    }
    return [...ranked, ...remaining];
}

function priorityForRank(rank: number, total: number): Task['priority'] {
    if (rank < Math.ceil(total / 3)) return 'high';
    if (rank < Math.ceil((2 * total) / 3)) return 'medium';
    return 'low';
}

export function buildServer(reqCtx: McpRequestContext): McpServer {
    const server = new McpServer(
        { name: 'todos', version: '1.0.0' },
        {
            capabilities: { logging: {}, resources: { listChanged: true, subscribe: true } },
            requestState: { verify: stateCodec.verify },
            instructions:
                'todos is a small project todo board (it starts empty). Use list_tasks to see the board, add_task / add_tasks and complete_task to ' +
                'change it, prioritize to rank the open tasks, brainstorm_tasks to invent themed example tasks, work_through_tasks to finish every ' +
                'open task with progress updates, and clear_done to remove finished ones (it asks the user for confirmation). The full board is ' +
                'also available as the todos://board resource, and it can be watched/subscribed to for change notifications. ' +
                'When the user greets you or asks what to try, suggest this tour: 1) ask to brainstorm tasks (the server asks how many — ' +
                'elicitation — then borrows the host model — sampling), 2) ask to prioritize the open tasks (sampling), 3) run the plan-my-day ' +
                'prompt, 4) attach the todos://board resource as context and ask about it, 5) say "do all my tasks" and watch the progress and ' +
                'log notifications, 6) ask to clear completed tasks (an elicitation-confirmed bulk delete). Watching the board resource ' +
                '(/watch in cli-client) shows live change notifications along the way.'
        }
    );

    // Per-resource subscriptions: 2025-era clients call resources/subscribe (tracked here so
    // updates only go to subscribers); 2026-07-28 clients use a subscriptions/listen filter and
    // the serving entry routes the same notification onto it.
    const subscribedUris = new Set<string>();
    server.server.setRequestHandler('resources/subscribe', request => {
        subscribedUris.add(request.params.uri);
        return {};
    });
    server.server.setRequestHandler('resources/unsubscribe', request => {
        subscribedUris.delete(request.params.uri);
        return {};
    });

    /** Tell connected clients the board changed: the resource list, and the board resource for watchers. */
    const announceBoardChange = async (): Promise<void> => {
        await server.sendResourceListChanged();
        if (publishBoardUpdated) {
            // Per-request HTTP serving: cross-request delivery goes through the entry's notifier.
            publishBoardChanged?.();
            publishBoardUpdated('todos://board');
        } else if (reqCtx.era === 'modern' || subscribedUris.has('todos://board')) {
            // stdio: the serving entry routes this onto open listen subscriptions (2026-07-28);
            // on 2025-era connections it goes out unsolicited, so only send it to subscribers.
            await server.server.sendResourceUpdated({ uri: 'todos://board' }).catch(() => {});
        }
    };

    server.registerResource(
        'board',
        'todos://board',
        { description: 'The whole todo board as markdown', mimeType: 'text/markdown' },
        async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: renderBoard() }] })
    );

    server.registerResource(
        'task',
        new ResourceTemplate('todos://tasks/{id}', {
            list: async () => ({
                resources: [...tasks.values()].map(task => ({
                    uri: `todos://tasks/${task.id}`,
                    name: task.title,
                    mimeType: 'text/markdown'
                }))
            }),
            complete: { id: value => [...tasks.keys()].filter(id => id.startsWith(value)) }
        }),
        { description: 'A single task by id', mimeType: 'text/markdown' },
        async (uri, variables) => {
            const task = tasks.get(String(variables.id));
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: 'text/markdown',
                        text: task ? describeTask(task) : `No task with id ${String(variables.id)}`
                    }
                ]
            };
        }
    );

    server.registerPrompt(
        'seed-board',
        {
            description: 'Have the assistant invent themed example tasks and add them to the board (via add_tasks)',
            argsSchema: z.object({
                theme: completable(z.string().describe('A theme for the invented tasks'), value =>
                    [
                        'space-station maintenance',
                        'wizard tower chores',
                        'startup launch week',
                        "engineer's week in hell",
                        'robot uprising prep'
                    ].filter(theme => theme.startsWith(value))
                )
            })
        },
        async ({ theme }) => ({
            messages: [
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Invent five short, funny todo tasks for the theme "${theme}" and add them to my board with the add_tasks tool (use "${theme}" as the project). Then show me the board.`
                    }
                }
            ]
        })
    );

    server.registerPrompt(
        'plan-my-day',
        {
            description: 'Seed a planning conversation around the current board',
            argsSchema: z.object({
                focus: completable(z.string().describe('Project to focus on'), value =>
                    projects().filter(project => project.startsWith(value))
                )
            })
        },
        async ({ focus }) => ({
            messages: [
                { role: 'user', content: { type: 'text', text: `Here is my current todo board:\n\n${renderBoard()}` } },
                { role: 'assistant', content: { type: 'text', text: 'Got it — I can see your board. What should today look like?' } },
                {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: `Plan my day around the "${focus}" project: pick at most three tasks, in order, and say why each one is next.`
                    }
                }
            ]
        })
    );

    server.registerTool(
        'add_task',
        {
            description: 'Add a task to the board',
            inputSchema: z.object({
                title: z.string().describe('What needs doing'),
                project: z.string().optional().describe('Project bucket, e.g. "ops"'),
                priority: z.enum(['high', 'medium', 'low']).optional(),
                due: z.string().optional().describe('Free-form due date, e.g. "Friday"'),
                notes: z.string().optional()
            }),
            outputSchema: z.object({ id: z.string(), title: z.string(), status: z.enum(['open', 'done']) })
        },
        async ({ title, project, priority, due, notes }, ctx) => {
            const task = addTask({ title, project: project ?? 'inbox', priority, due, notes });
            await announceBoardChange();
            await logInfo(ctx, `added ${task.id}: ${task.title}`);
            return {
                content: [{ type: 'text', text: `Added ${task.id}: ${describeTask(task)}` }],
                structuredContent: { id: task.id, title: task.title, status: task.status }
            };
        }
    );

    server.registerTool(
        'add_tasks',
        {
            description: 'Add several tasks to the board at once',
            inputSchema: z.object({
                tasks: z
                    .array(
                        z.object({
                            title: z.string(),
                            project: z.string().optional(),
                            priority: z.enum(['high', 'medium', 'low']).optional(),
                            due: z.string().optional(),
                            notes: z.string().optional()
                        })
                    )
                    .min(1)
                    .describe('Tasks to add')
            })
        },
        async ({ tasks: newTasks }, ctx) => {
            const added: Task[] = [];
            for (const [index, task] of newTasks.entries()) {
                // Pretend each insert takes a moment so the host has in-flight progress to render.
                await new Promise(resolve => setTimeout(resolve, 100));
                added.push(addTask({ ...task, project: task.project ?? 'inbox' }));
                await reportProgress(ctx, index + 1, newTasks.length, `added "${task.title}"`);
            }
            await announceBoardChange();
            await logInfo(ctx, `added ${added.length} task(s)`);
            return {
                content: [{ type: 'text', text: `Added ${added.length} task(s):\n${added.map(task => describeTask(task)).join('\n')}` }]
            };
        }
    );

    server.registerTool(
        'brainstorm_tasks',
        {
            description:
                'Invent short, funny example tasks for a theme and add them to the board — asks the user how many (elicitation), then has the LLM connected to the host invent them (sampling)',
            inputSchema: z.object({
                theme: z.string().optional().describe('Theme for the invented tasks (default: "an engineer\'s week in hell")')
            })
        },
        async ({ theme }, ctx): Promise<CallToolResult | InputRequiredResult> => {
            // The theme can come from the model (tool argument) or from the user (the elicitation
            // form's theme field, pre-filled with a default); the user's answer wins.
            const fallbackTopic = theme ?? "an engineer's week in hell";
            const resolveTopic = (raw: unknown): string => (typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallbackTopic);
            const countMessage = 'Let me invent some tasks for the board.';

            const finish = async (ideasText: string, wanted: number, topic: string): Promise<CallToolResult> => {
                const titles = ideasText
                    .split('\n')
                    .map(line => line.replace(/^[-*\d.\s]+/, '').trim())
                    .filter(line => line.length > 0)
                    .slice(0, wanted);
                if (titles.length === 0) {
                    return { content: [{ type: 'text', text: 'The model did not return any task ideas.' }], isError: true };
                }
                const added = titles.map(title => addTask({ title, project: topic }));
                await announceBoardChange();
                await logInfo(ctx, `brainstormed ${added.length} task(s) for "${topic}"`);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Added ${added.length} brainstormed task(s):\n${added.map(task => describeTask(task)).join('\n')}`
                        }
                    ]
                };
            };
            const declined = (action: string): CallToolResult => ({
                content: [{ type: 'text', text: `Nothing added (user answered: ${action}).` }]
            });

            // The whole conversation as a multi-round input_required chain — written ONCE.
            // The handler is a state machine over BrainstormState — it dispatches on
            // `state.step` (not on which inputResponses key arrived), so each round knows
            // exactly which answer to read and which data is in scope. State is HMAC-signed
            // by stateCodec; the seam verified integrity AND decoded the payload before this
            // handler ran — the typed accessor returns it. On a 2025-era session the SDK's
            // legacy shim fulfils each round as real push-style requests; the handler never
            // branches on the served era.
            const state = ctx.mcpReq.requestState<BrainstormState>();
            const askForIdeas = async (count: number, topic: string): Promise<InputRequiredResult> =>
                inputRequired({
                    inputRequests: { ideas: inputRequired.createMessage(buildBrainstormSampling(topic, count)) },
                    requestState: await stateCodec.mint({ step: 'awaiting-ideas', topic, count }, ctx)
                });

            switch (state?.step) {
                case undefined: {
                    // First call: ask for the theme and count.
                    return inputRequired({
                        inputRequests: { count: inputRequired.elicit({ message: countMessage, requestedSchema: BRAINSTORM_COUNT_SCHEMA }) },
                        requestState: await stateCodec.mint({ step: 'awaiting-count' }, ctx)
                    });
                }
                case 'awaiting-count': {
                    const response = ctx.mcpReq.inputResponses?.['count'];
                    const accepted = acceptedContent<{ count?: string; theme?: string }>(ctx.mcpReq.inputResponses, 'count');
                    if (accepted === undefined) return declined(elicitAction(response));
                    const topic = resolveTopic(accepted.theme);
                    if (accepted.count === 'custom') {
                        return inputRequired({
                            inputRequests: {
                                customCount: inputRequired.elicit({
                                    message: 'How many exactly?',
                                    requestedSchema: BRAINSTORM_CUSTOM_COUNT_SCHEMA
                                })
                            },
                            requestState: await stateCodec.mint({ step: 'awaiting-custom-count', topic }, ctx)
                        });
                    }
                    const wanted = parseBrainstormCount(accepted.count);
                    if (wanted === undefined) return declined('cancel');
                    return askForIdeas(wanted, topic);
                }
                case 'awaiting-custom-count': {
                    const response = ctx.mcpReq.inputResponses?.['customCount'];
                    const accepted = acceptedContent<{ customCount?: number }>(ctx.mcpReq.inputResponses, 'customCount');
                    const wanted = parseBrainstormCount(accepted?.customCount);
                    if (wanted === undefined) return declined(elicitAction(response));
                    return askForIdeas(wanted, state.topic);
                }
                case 'awaiting-ideas': {
                    return finish(sampledText(ctx.mcpReq.inputResponses?.['ideas']), state.count, state.topic);
                }
            }
        }
    );

    server.registerTool(
        'list_tasks',
        {
            description: 'List tasks on the board',
            inputSchema: z.object({
                status: z.enum(['open', 'done', 'all']).optional().describe('Which tasks to list (default: open)'),
                project: z.string().optional().describe('Only tasks in this project')
            })
        },
        async ({ status, project }) => {
            const wanted = status ?? 'open';
            const matching = [...tasks.values()].filter(
                task => (wanted === 'all' || task.status === wanted) && (!project || task.project === project)
            );
            return {
                content: [
                    {
                        type: 'text',
                        text: matching.length === 0 ? 'No matching tasks.' : matching.map(task => describeTask(task)).join('\n')
                    }
                ]
            };
        }
    );

    server.registerTool(
        'complete_task',
        {
            description: 'Mark a task as done',
            inputSchema: z.object({ task: z.string().describe('Task id, or part of its title') })
        },
        async ({ task: query }, ctx) => {
            const needle = query.toLowerCase();
            const task = tasks.get(query) ?? [...tasks.values()].find(candidate => candidate.title.toLowerCase().includes(needle));
            if (!task) {
                return { content: [{ type: 'text', text: `No task matches "${query}".` }], isError: true };
            }
            task.status = 'done';
            await announceBoardChange();
            await logInfo(ctx, `completed ${task.id}: ${task.title}`);
            return { content: [{ type: 'text', text: `Marked "${task.title}" (${task.id}) as done.` }] };
        }
    );

    server.registerTool(
        'work_through_tasks',
        {
            description:
                'Work through every open task one by one (simulated, a few seconds each), logging what it is "doing", reporting progress, and marking each as done',
            inputSchema: z.object({
                secondsPerTask: z.number().min(0).max(15).optional().describe('How long to pretend each task takes (default: 3 seconds)')
            })
        },
        async ({ secondsPerTask }, ctx) => {
            const queue = openTasks();
            if (queue.length === 0) {
                return { content: [{ type: 'text', text: 'Nothing open — the board is already clear.' }] };
            }
            const paceMs = (secondsPerTask ?? 3) * 1000;
            for (const [index, task] of queue.entries()) {
                // Honour cancellation: if the client aborted the call (notifications/cancelled),
                // stop early instead of ploughing through the rest of the queue.
                if (ctx.mcpReq.signal.aborted) {
                    return {
                        content: [
                            { type: 'text', text: `Stopped early — the request was cancelled after ${index} of ${queue.length} task(s).` }
                        ]
                    };
                }
                // Narrate the "work" (a log notification per task), pretend it takes a moment so the
                // host has live progress to render, then announce the board change for watchers.
                await logInfo(ctx, `working on "${task.title}" — ${WORK_QUIPS[index % WORK_QUIPS.length] ?? 'working'}…`);
                await new Promise(resolve => setTimeout(resolve, paceMs));
                task.status = 'done';
                await reportProgress(ctx, index + 1, queue.length, `finished "${task.title}"`);
                await announceBoardChange();
            }
            await logInfo(ctx, `worked through ${queue.length} open task(s)`);
            return {
                content: [
                    { type: 'text', text: `Worked through ${queue.length} task(s):\n${queue.map(task => `- ${task.title} ✔`).join('\n')}` }
                ]
            };
        }
    );

    server.registerTool(
        'clear_done',
        { description: 'Delete every completed task (asks the user to confirm first)' },
        async (ctx): Promise<CallToolResult | InputRequiredResult> => {
            const done = [...tasks.values()].filter(task => task.status === 'done');
            if (done.length === 0) return { content: [{ type: 'text', text: 'No completed tasks to clear.' }] };
            const message = `Delete ${done.length} completed task(s) from the board?`;

            // A single input_required round, written once for both eras — the first call has
            // no inputResponses and returns the question; the re-call carries the answer.
            // (For multi-round flows, dispatch on a discriminated requestState instead — see
            // brainstorm_tasks.) On 2025-era sessions the SDK's legacy shim asks the question
            // as a real push-style elicitation.
            const response = ctx.mcpReq.inputResponses?.['confirmation'];
            if (response === undefined) {
                return inputRequired({
                    inputRequests: { confirmation: inputRequired.elicit({ message, requestedSchema: CLEAR_CONFIRM_SCHEMA }) }
                });
            }
            const action = elicitAction(response);
            const confirmation = acceptedContent<{ confirm?: boolean }>(ctx.mcpReq.inputResponses, 'confirmation');

            if (confirmation?.confirm !== true) {
                // Decline and cancel are answers — report them and stop, never ask again.
                return { content: [{ type: 'text', text: `Nothing deleted (user answered: ${action}).` }] };
            }
            for (const task of done) tasks.delete(task.id);
            await announceBoardChange();
            await logInfo(ctx, `cleared ${done.length} completed task(s)`);
            return { content: [{ type: 'text', text: `Deleted ${done.length} completed task(s).` }] };
        }
    );

    server.registerTool(
        'prioritize',
        { description: 'Rank the open tasks by importance using the LLM connected to the host, and update their priorities' },
        async (ctx): Promise<CallToolResult | InputRequiredResult> => {
            const candidates = openTasks();
            if (candidates.length === 0) return { content: [{ type: 'text', text: 'No open tasks to prioritize.' }] };
            const samplingRequest = {
                systemPrompt: 'You prioritize todo lists. Reply with one task title per line, most important first. No commentary.',
                messages: [
                    {
                        role: 'user' as const,
                        content: {
                            type: 'text' as const,
                            text: `Rank these tasks:\n${candidates.map(task => `- ${task.title}`).join('\n')}`
                        }
                    }
                ],
                maxTokens: 400
            };

            // A single input_required round, written once for both eras (the ranking arrives
            // on the retried call), so no requestState is needed. For multi-round flows,
            // dispatch on a discriminated requestState instead — see brainstorm_tasks. On
            // 2025-era sessions the SDK's legacy shim performs the sampling round trip.
            const response = ctx.mcpReq.inputResponses?.['ranking'];
            if (response === undefined) {
                return inputRequired({ inputRequests: { ranking: inputRequired.createMessage(samplingRequest) } });
            }
            const rankingText = sampledText(response);

            const ranked = applyRanking(rankingText, candidates);
            for (const [index, task] of ranked.entries()) {
                task.priority = priorityForRank(index, ranked.length);
            }
            // Priorities are board-visible state — watchers and list caches must hear about it.
            await announceBoardChange();
            await logInfo(ctx, `prioritize: ranked ${ranked.length} open task(s) via the host LLM`);
            return {
                content: [
                    {
                        type: 'text',
                        text: `Re-prioritized ${ranked.length} task(s):\n${ranked.map(task => `- ${task.title} → ${task.priority}`).join('\n')}`
                    }
                ]
            };
        }
    );

    return server;
}
