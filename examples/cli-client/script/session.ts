import { check } from '@mcp-examples/shared';

import type { McpHost } from '../host/host';
import type { ChatMessage, GenerateRequest } from '../providers/provider';
import type { ScriptedProvider, ScriptedTurn } from '../providers/scripted';
import type { ScriptedUI } from './scriptedUi';

/**
 * The scripted e2e conversation the CI driver replays against the sibling todos-server.
 * Each provider turn plays the model's part and asserts on the request the host built for it,
 * so a passing run proves the loop, namespacing, resource attachment, prompt-role handling,
 * sampling, and elicitation all actually round-tripped.
 */
export interface ScriptedSession {
    turns: ScriptedTurn[];
    inputs: string[];
    confirmAnswers: boolean[];
    askAnswers: string[];
    /** Hooks the driver runs once before each input is dispatched (e.g. to arm cancellation). */
    beforeInput?: Array<((ui: ScriptedUI) => void) | undefined>;
    verify(context: { ui: ScriptedUI; provider: ScriptedProvider; host: McpHost; era: string; transport: string }): Promise<void>;
}

function messageText(message: ChatMessage): string {
    return message.content.map(part => (part.type === 'text' ? part.text : `[image]`)).join('\n');
}

function lastMessage(request: GenerateRequest): ChatMessage {
    const message = request.messages.at(-1);
    check.ok(message, 'expected at least one message');
    return message;
}

export function buildScriptedSession(options: { interactive: boolean }): ScriptedSession {
    const { interactive } = options;
    const turns: ScriptedTurn[] = [];
    const beforeInput: Array<((ui: ScriptedUI) => void) | undefined> = [];
    const inputs: string[] = ['Add a task to write the Q3 report by Friday, high priority.'];

    // 1. Plain chat → the model calls a namespaced tool, the result comes back, it answers.
    turns.push(
        {
            expect: request => {
                check.ok(request.system?.includes('todo board'), 'system prompt should fold in the todos server instructions');
                check.ok(
                    request.tools?.some(tool => tool.name === 'mcp__todos__add_task'),
                    'aggregated tools should include the namespaced add_task'
                );
            },
            toolCalls: [
                {
                    id: 'call_add',
                    name: 'mcp__todos__add_task',
                    arguments: { title: 'Write the Q3 report', project: 'planning', priority: 'high', due: 'Friday' }
                }
            ]
        },
        {
            expect: request => {
                const message = lastMessage(request);
                check.equal(message.role, 'tool', 'tool result should be fed back as a tool message');
                check.ok(message.role === 'tool' && message.isError !== true, 'add_task should not error');
                check.ok(messageText(message).includes('Write the Q3 report'), 'tool result should mention the new task');
            },
            text: 'Added "Write the Q3 report" to the board as a high-priority task due Friday.'
        }
    );

    // 2. Bulk add → per-item progress notifications stream while the tool runs.
    inputs.push('Also add tasks to update the cli-client docs and to fix the flaky deploy test.');
    turns.push(
        {
            toolCalls: [
                {
                    id: 'call_bulk',
                    name: 'mcp__todos__add_tasks',
                    arguments: {
                        tasks: [
                            { title: 'Update the cli-client docs', project: 'cli-client' },
                            { title: 'Fix the flaky deploy test', project: 'ops' }
                        ]
                    }
                }
            ]
        },
        {
            expect: request => {
                check.ok(messageText(lastMessage(request)).includes('Added 2 task(s)'), 'add_tasks should report both tasks');
            },
            text: 'Added both tasks to the board.'
        }
    );

    // 3. @-mention → the board resource is injected as provenance-labelled context.
    inputs.push('@todos:todos://board which of these should I tackle first?');
    turns.push({
        expect: request => {
            const message = lastMessage(request);
            check.equal(message.role, 'user');
            const text = messageText(message);
            check.ok(text.includes('<attached-resource server="todos" uri="todos://board">'), 'resource context should carry provenance');
            check.ok(text.includes('Write the Q3 report'), 'attached board should already contain the new task');
        },
        text: 'Start with the Q3 report — it is high priority and due Friday.'
    });

    // Watch the board: a host command (no model turn); later mutations should produce update notes.
    inputs.push('/watch @todos:todos://board', '/todos:plan-my-day focus=cli-client');
    turns.push({
        expect: request => {
            const fromPrompt = request.messages.filter(
                message => message.role === 'assistant' && messageText(message).includes('I can see your board')
            );
            check.equal(fromPrompt.length, 1, 'the prompt-provided assistant turn should stay an assistant turn');
            check.ok(
                request.messages.some(message => message.role === 'user' && messageText(message).includes('"cli-client" project')),
                'the prompt argument should appear in the seeded user turn'
            );
        },
        text: 'Plan for today: 1) Review the cli-client pull request, 2) Send standup notes to the team.'
    });

    if (interactive) {
        // 4a. The deepest multi-round flow: brainstorm_tasks (theme+count elicitation form,
        // then approval-gated sampling, with HMAC-signed requestState carried between rounds).
        inputs.push('Brainstorm a few tasks for me.');
        turns.push(
            { toolCalls: [{ id: 'call_brainstorm', name: 'mcp__todos__brainstorm_tasks', arguments: {} }] },
            {
                expect: request => {
                    check.ok(!request.tools?.length, 'the brainstorm sampling request should not carry the chat tools');
                    check.ok(
                        messageText(lastMessage(request)).includes('Invent 5 todo tasks'),
                        'the brainstorm sampling request should carry the resolved theme and count'
                    );
                },
                text: ['Reboot the flux capacitor', 'Explain the snorkel cluster outage', 'Convince Jenkins to behave'].join('\n')
            },
            {
                expect: request => {
                    const message = lastMessage(request);
                    check.equal(message.role, 'tool');
                    check.ok(messageText(message).includes('Added 3 brainstormed task(s)'), 'brainstorm should report the tasks it added');
                },
                text: 'Three brainstormed tasks added to the board.'
            }
        );

        // 4b. Sampling: the prioritize tool borrows the host's model (after the approval gate).
        inputs.push('Prioritize my open tasks.');
        turns.push(
            { toolCalls: [{ id: 'call_prioritize', name: 'mcp__todos__prioritize', arguments: {} }] },
            {
                expect: request => {
                    check.ok(!request.tools?.length, 'sampling requests should not carry the chat tools');
                    check.ok(request.system?.includes('prioritize todo lists'), 'sampling should pass the server systemPrompt through');
                    check.ok(
                        messageText(lastMessage(request)).includes('Rank these tasks'),
                        'sampling should carry the server-provided messages'
                    );
                },
                text: ['Write the Q3 report', 'Fix the flaky deploy test', 'Update the cli-client docs'].join('\n')
            },
            {
                expect: request => {
                    const message = lastMessage(request);
                    check.equal(message.role, 'tool');
                    check.ok(messageText(message).includes('Re-prioritized'), 'prioritize result should report the new ranking');
                },
                text: 'Done — I ranked your open tasks and updated their priorities.'
            }
        );
    }

    // 5. Another tool round (gives clear_done something to delete).
    inputs.push('Mark the flaky deploy test task as done.');
    turns.push(
        { toolCalls: [{ id: 'call_complete', name: 'mcp__todos__complete_task', arguments: { task: 'flaky deploy' } }] },
        {
            expect: request => {
                check.ok(messageText(lastMessage(request)).includes('Marked'), 'complete_task result should confirm');
            },
            text: 'Marked "Fix the flaky deploy test" as done.'
        }
    );

    if (interactive) {
        // 6. Elicitation: clear_done asks for confirmation through a terminal form.
        inputs.push('Clear my completed tasks.');
        turns.push(
            { toolCalls: [{ id: 'call_clear', name: 'mcp__todos__clear_done', arguments: {} }] },
            {
                expect: request => {
                    check.ok(messageText(lastMessage(request)).includes('Deleted'), 'clear_done should report how many tasks it deleted');
                },
                text: 'Cleared the completed tasks from the board.'
            }
        );
    }

    // Finale: a long-running tool — work through whatever is still open, with live progress.
    inputs.push('Now work through everything that is still open.');
    turns.push(
        { toolCalls: [{ id: 'call_work', name: 'mcp__todos__work_through_tasks', arguments: { secondsPerTask: 0.3 } }] },
        {
            expect: request => {
                check.ok(messageText(lastMessage(request)).includes('Worked through'), 'work_through_tasks should report what it finished');
            },
            text: 'All done — every open task has been worked through.'
        }
    );

    // Cancellation: add fresh tasks, start a slow work-through, and abort it on the first
    // progress line — proving the host signal abort → notifications/cancelled → tool-error
    // path round-trips and the model is told.
    inputs.push('Add a couple of placeholder tasks and start working through them.');
    beforeInput[inputs.length - 1] = ui => {
        ui.cancelOnStatusMatching = 'mcp__todos__work_through_tasks: finished';
    };
    turns.push(
        {
            toolCalls: [
                {
                    id: 'call_seed_cancel',
                    name: 'mcp__todos__add_tasks',
                    arguments: {
                        tasks: [
                            { title: 'Placeholder task A', project: 'cancel-test' },
                            { title: 'Placeholder task B', project: 'cancel-test' }
                        ]
                    }
                },
                { id: 'call_work_cancel', name: 'mcp__todos__work_through_tasks', arguments: { secondsPerTask: 0.6 } }
            ]
        },
        {
            expect: request => {
                const message = lastMessage(request);
                check.equal(message.role, 'tool');
                check.ok(
                    message.role === 'tool' && message.isError === true,
                    'a cancelled tool call should reach the model as an error result'
                );
                check.ok(messageText(message).includes('cancelled by the user'), 'the cancellation should be labelled');
            },
            text: 'Stopped — that work-through was cancelled.'
        }
    );

    return {
        turns,
        inputs,
        beforeInput,
        // brainstorm: theme '' (Enter for default) + count '5'; clear_done: confirm 'y'.
        // brainstorm + prioritize each gate one sampling approval.
        confirmAnswers: interactive ? [true, true] : [],
        askAnswers: interactive ? ['', '5', 'y'] : [],
        async verify({ ui, provider, host, transport }) {
            check.equal(provider.remaining, 0, 'every scripted model turn should have been consumed');
            check.equal(ui.unansweredConfirms, 0, 'every scripted confirmation should have been consumed');
            check.equal(ui.unansweredAsks, 0, 'every scripted form answer should have been consumed');

            // End-state assertions against the live server, read the same way a user would.
            const todos = host.servers.get('todos');
            check.ok(todos, 'the todos server should be connected');
            const board = await todos.client.readResource({ uri: 'todos://board' });
            const boardText = board.contents.map(item => ('text' in item ? item.text : '')).join('\n');
            check.ok(boardText.includes('Write the Q3 report'), 'the added task should be on the board');
            if (interactive) {
                // 'low' can only come from the prioritize ranking — nothing else assigns a low priority.
                check.ok(boardText.includes('priority: low'), 'prioritize should have stamped priorities');
                check.ok(!boardText.includes('Fix the flaky deploy test'), 'clear_done should have removed the completed task');
            } else {
                check.ok(boardText.includes('[x] Fix the flaky deploy test'), 'complete_task should have marked the task done');
            }

            if (interactive) {
                check.ok(
                    ui.printed.some(text => text.includes('wants to run an LLM request')),
                    'the sampling approval gate should have been shown'
                );
                check.ok(
                    ui.questions.some(question => question.includes('Allow?')),
                    'the sampling approval question should have been asked'
                );
            }
            // completion/complete: the seed-board theme arg is completable() with a fixed list.
            const themeCompletions = await host.completePromptArgument('todos', 'seed-board', 'theme', 'space');
            check.ok(
                themeCompletions.includes('space-station maintenance'),
                'completion/complete should return matching completable() values for prompt arguments'
            );
            const focusCompletions = await host.completePromptArgument('todos', 'plan-my-day', 'focus', '');
            check.ok(focusCompletions.length > 0, 'completion/complete should return current project names for plan-my-day focus');

            check.ok(
                ui.statuses.some(status => status.includes('watching @todos:todos://board')),
                'the /watch command should have subscribed to the board'
            );
            check.ok(!ui.statuses.some(status => status.includes('could not watch')), 'the /watch subscription should not have failed');
            check.ok(
                ui.statuses.some(status => status.includes('cancelling mcp__todos__work_through_tasks')),
                'the scripted cancellation should have fired'
            );
            if (interactive) {
                check.ok(
                    ui.questions.some(question => question.includes('Theme for the invented tasks')),
                    'brainstorm_tasks should have elicited the theme/count form'
                );
                check.ok(boardText.includes('Reboot the flux capacitor'), 'brainstormed tasks should be on the board');
            }
            if (transport === 'stdio') {
                // 'todos info' entries can only come from notifications/message — stderr lines are tagged 'stderr'.
                check.ok(
                    ui.serverLogs.some(log => log.level.includes('info')),
                    'server log notifications should have been rendered'
                );
                check.ok(
                    ui.statuses.some(status => status.includes('resource list changed')),
                    'resources/list_changed should have refreshed the cached list'
                );
            }
            if (transport === 'stdio') {
                check.ok(
                    ui.statuses.some(status => status.includes('mcp__todos__add_tasks') && status.includes('(2/2)')),
                    'progress notifications from add_tasks should have been rendered'
                );
                check.ok(
                    ui.statuses.some(status => status.includes('mcp__todos__work_through_tasks') && status.includes('/')),
                    'progress notifications from work_through_tasks should have been rendered'
                );
                check.ok(
                    ui.serverLogs.some(log => log.text.includes('working on')),
                    'work_through_tasks should narrate each task through log notifications'
                );
                check.ok(
                    ui.statuses.some(status => status.includes('resource updated:')),
                    'watching the board should have produced resources/updated notes'
                );
            }
        }
    };
}
