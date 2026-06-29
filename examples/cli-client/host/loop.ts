import { getDisplayName } from '@modelcontextprotocol/client';

import type { ChatMessage, ContentPart, GenerateResult, LLMProvider } from '../providers/provider';
import { textPart } from '../providers/provider';
import { partsToDisplayText } from './content';
import type { McpHost } from './host';
import type { HostUI } from './ui';

/** A model that keeps calling tools forever is a bug, not a feature — bound the loop. */
export const MAX_TOOL_ROUNDS = 8;

const BASE_SYSTEM_PROMPT =
    'You are cli-client, a terminal assistant. You have no built-in tools; every tool available to you comes from a connected MCP server. ' +
    'Use them when they help, report tool failures honestly, and keep answers short — this is a terminal. ' +
    'When the user greets you or asks what you can do, offer a short tour of what the connected servers provide (their instructions may suggest one).';

export interface ChatSession {
    host: McpHost;
    provider: LLMProvider;
    ui: HostUI;
    messages: ChatMessage[];
    maxTokens: number;
    /** Last model id reported by the provider; announced once so users can see what answered. */
    announcedModel?: string;
}

export function createSession(host: McpHost, provider: LLMProvider, ui: HostUI, maxTokens = 1024): ChatSession {
    return { host, provider, ui, messages: [], maxTokens };
}

export function buildSystemPrompt(host: McpHost): string {
    const instructions = host.systemInstructions();
    return instructions ? `${BASE_SYSTEM_PROMPT}\n\n${instructions}` : BASE_SYSTEM_PROMPT;
}

/**
 * The loop at the heart of every MCP host:
 * ask the model → execute every tool call it issued → feed the results back → repeat until
 * the model answers in prose (or the round cap is hit). Tool results go back as `role: 'tool'`
 * messages so each provider can encode them natively, and `isError` results still go to the
 * model — it is allowed to read the error and try something else.
 */
//#region theLoop
export async function runModelRounds(session: ChatSession): Promise<void> {
    const { host, provider, ui } = session;
    // Server instructions and the aggregated tool list are stable within a single user turn.
    const system = buildSystemPrompt(host);
    const tools = host.toolDefinitions();
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const stopSpinner = ui.spinner();
        let result: GenerateResult;
        try {
            result = await provider.generate({
                system,
                messages: session.messages,
                tools,
                maxTokens: session.maxTokens
            });
        } finally {
            stopSpinner();
        }
        session.messages.push({
            role: 'assistant',
            content: result.text ? [textPart(result.text)] : [],
            ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {})
        });
        if (result.model !== session.announcedModel) {
            session.announcedModel = result.model;
            ui.status(`model: ${result.model}`);
        }
        if (result.text) ui.print(result.text);
        if (result.toolCalls.length === 0) return;

        // cli-client executes tool calls without a confirmation gate because an interactive
        // user watches every `→` line and holds Ctrl-C; a host without that live supervision
        // must gate execution on user consent (see the guide's security section).
        for (const call of result.toolCalls) {
            ui.status(`→ ${call.name} ${JSON.stringify(call.arguments)}`);
            // Long-running calls stay cancellable: Ctrl-C aborts this call (the SDK sends
            // notifications/cancelled) and the failure goes back to the model like any other.
            const cancellation = new AbortController();
            ui.setCancelHandler(() => {
                ui.status(`cancelling ${call.name}…`, 'cancel');
                cancellation.abort();
            });
            let parts: ContentPart[];
            let isError: boolean;
            try {
                ({ parts, isError } = await host.executeToolCall(call, { signal: cancellation.signal }));
            } finally {
                ui.setCancelHandler(undefined);
            }
            const summary = partsToDisplayText(parts);
            ui.status(`${isError ? '✗' : '✓'} ${call.name}: ${summary.length > 200 ? `${summary.slice(0, 200)}…` : summary}`);
            session.messages.push({ role: 'tool', toolCallId: call.id, toolName: call.name, content: parts, isError });
        }
    }
    ui.print('(stopped: tool-call round limit reached)');
}
//#endregion theLoop

/** Send one user turn (with optional attached-resource context blocks) through the loop. */
export async function runConversationTurn(session: ChatSession, userText: string, attachments: string[] = []): Promise<void> {
    const content: ContentPart[] = [...attachments.map(attachment => textPart(attachment)), textPart(userText)];
    session.messages.push({ role: 'user', content });
    await runModelRounds(session);
}

/** Pull `@server:uri` mentions out of a chat line (server names may contain dots, spaces excepted). */
export function extractMentions(input: string): { text: string; mentions: string[] } {
    const mentions = [...input.matchAll(/@([^\s:@]+:\S+)/g)].map(match => match[1]).filter(mention => mention !== undefined);
    return { text: input.trim(), mentions };
}

/** Parse `key=value` arguments for a `/server:prompt` command. */
export function parsePromptArgs(rest: string): Record<string, string> {
    const args: Record<string, string> = {};
    for (const [, key, raw] of rest.matchAll(/([A-Za-z0-9_-]+)=("[^"]*"|\S+)/g)) {
        if (key && raw !== undefined) {
            args[key] = raw.replaceAll(/^"|"$/g, '');
        }
    }
    return args;
}

const HELP = `cli-client commands:
  /help                       show this help
  /servers                    connected servers and what they offer
  /tools                      every (namespaced) tool the model can call
  /resources                  resources you can attach with @server:uri
  /prompts                    prompts you can run as /server:prompt-name [key=value …]
  /roots                      workspace roots exposed to servers
  /root add <path>            add a workspace root (sends roots/list_changed)
  /watch @server:uri          get a note whenever that resource changes
  /quit                       exit
  @server:uri                 attach a resource to your next message as context
  /server:prompt-name k=v …   run an MCP prompt as a slash command
  Ctrl-C                      cancel the tool call that is currently running (otherwise exit)`;

export type InputResult = 'continue' | 'exit';

/** Print rows as an aligned two-column listing, one line per row, trimmed to the terminal width. */
function printAligned(ui: HostUI, rows: ReadonlyArray<readonly string[]>, emptyMessage: string): void {
    if (rows.length === 0) {
        ui.print(emptyMessage);
        return;
    }
    const nameWidth = Math.min(Math.max(...rows.map(row => row[0]?.length ?? 0), 0), 48);
    const columns = process.stdout.columns ?? 120;
    for (const [name = '', description = ''] of rows) {
        const line = `${name.padEnd(nameWidth)}  ${description}`;
        ui.print(line.length > columns ? `${line.slice(0, columns - 1)}…` : line);
    }
}

/**
 * Dispatch one line of user input: built-in slash commands, `/server:prompt` commands,
 * or a plain chat message (with `@server:uri` attachments resolved first).
 */
export async function handleUserInput(session: ChatSession, input: string): Promise<InputResult> {
    const { host, ui } = session;
    const trimmed = input.trim();
    if (!trimmed) return 'continue';

    if (trimmed === '/quit' || trimmed === '/exit') return 'exit';
    if (trimmed === '/help') {
        ui.print(HELP);
        return 'continue';
    }
    if (trimmed === '/servers') {
        printAligned(
            ui,
            [...host.servers.values()].map(server => [
                server.name,
                `protocol ${server.protocolVersion}, ${server.tools.length} tools, ${server.resources.length} resources (+${server.resourceTemplates.length} templates), ${server.prompts.length} prompts`
            ]),
            '[no servers connected]'
        );
        return 'continue';
    }
    if (trimmed === '/tools') {
        printAligned(
            ui,
            host.toolDefinitions().map(tool => [tool.name, tool.description ?? '']),
            '[no tools found — the connected servers expose none]'
        );
        return 'continue';
    }
    if (trimmed === '/resources') {
        printAligned(
            ui,
            host.listResources().map(({ server, resource }) => [`@${server}:${resource.uri}`, getDisplayName(resource)]),
            '[no resources found — the connected servers expose none]'
        );
        return 'continue';
    }
    if (trimmed === '/prompts') {
        printAligned(
            ui,
            host.listPrompts().map(({ server, prompt }) => {
                const args = (prompt.arguments ?? []).map(argument => `${argument.name}${argument.required ? '' : '?'}`).join(' ');
                return [`/${server}:${prompt.name}${args ? ` ${args}` : ''}`, prompt.description ?? ''];
            }),
            '[no prompts found — the connected servers expose none]'
        );
        return 'continue';
    }
    if (trimmed === '/roots') {
        for (const root of host.listRoots()) ui.print(root);
        return 'continue';
    }
    if (trimmed.startsWith('/root add ')) {
        await host.addRoot(trimmed.slice('/root add '.length).trim());
        ui.status('root added');
        return 'continue';
    }
    if (trimmed === '/watch' || trimmed.startsWith('/watch ')) {
        const reference = trimmed.slice('/watch'.length).trim().replace(/^@/, '');
        if (!reference) {
            ui.print('usage: /watch @server:uri (see /resources)');
            return 'continue';
        }
        try {
            await host.watchResource(reference);
            ui.note(`watching @${reference} — you'll get a note when it changes`);
        } catch (error) {
            ui.status(`could not watch @${reference}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return 'continue';
    }

    // `/server:prompt-name key=value …` — MCP prompts become slash commands.
    const promptCommand = trimmed.match(/^\/([A-Za-z0-9_-]+):(\S+)\s*(.*)$/);
    if (promptCommand) {
        const serverName = promptCommand[1] ?? '';
        const promptName = promptCommand[2] ?? '';
        const rest = promptCommand[3] ?? '';
        const found = host.findPrompt(serverName, promptName);
        if (!found) {
            ui.print(`Unknown prompt: /${serverName}:${promptName} (see /prompts)`);
            return 'continue';
        }
        const args = parsePromptArgs(rest);
        for (const argument of found.prompt.arguments ?? []) {
            if (argument.required && args[argument.name] === undefined) {
                args[argument.name] = await ui.ask(
                    `[prompt argument] ${argument.name}${argument.description ? ` (${argument.description})` : ''}`
                );
            }
        }
        // The prompt's messages seed the conversation as-is — user and assistant turns stay
        // distinct turns rather than being flattened into one block of text.
        const messages = await host.getPromptMessages(found.server.name, found.prompt.name, args);
        session.messages.push(...messages);
        await runModelRounds(session);
        return 'continue';
    }

    const { text, mentions } = extractMentions(trimmed);
    const attachments: string[] = [];
    for (const mention of mentions) {
        try {
            attachments.push(await host.attachResource(mention));
            ui.note(`attached resource @${mention} as context`);
        } catch (error) {
            ui.status(
                `could not attach @${mention}: ${error instanceof Error ? error.message : String(error)} — mentions look like @server:uri (see /resources)`
            );
        }
    }
    await runConversationTurn(session, text, attachments);
    return 'continue';
}
