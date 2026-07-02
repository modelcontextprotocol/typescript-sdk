import type { Interface } from 'node:readline/promises';
import { createInterface } from 'node:readline/promises';

import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/client';

import { stripAnsi } from './content';
import type { McpHost } from './host';

// Minimal styling so a conversation is scannable: user input stays the terminal default,
// assistant prose is slightly dimmed, operational lines (tool calls, progress, logs) are grey,
// and anything that needs the user's decision (elicitation, approvals) is highlighted.
// Only applied on a TTY, so piped output stays plain text.
const useColor = process.stdout.isTTY === true;

function paint(style: string, text: string): string {
    return useColor ? `[${style}m${text}[0m` : text;
}

/**
 * Everything cli-client ever shows or asks a human goes through this interface, so the e2e
 * driver (client.ts) can swap in a scripted implementation and the rest of the host code
 * stays identical. The two `confirm` call sites that matter for safety are the sampling
 * approval gate and the OAuth browser-open prompt.
 */
export interface HostUI {
    /** Assistant output and primary information. */
    print(text: string): void;
    /** Transient operational lines: tool calls, progress, connection events. A 'cancel' tone marks user cancellations. */
    status(text: string, tone?: 'info' | 'cancel'): void;
    /** Something that needs the user's decision next (elicitation forms, approval requests). */
    attention(text: string): void;
    /** Something that just became part of the conversation but isn't prose (an attached resource). */
    note(text: string): void;
    /** A log notification received from a server. */
    serverLog(server: string, level: string, text: string): void;
    /** Yes/no decision gate. Must default to "no" on uncertainty. */
    confirm(question: string): Promise<boolean>;
    /** Free-form question (elicitation form fields, prompt arguments). */
    ask(question: string): Promise<string>;
    /** Show a "working…" indicator until the returned stop function is called. */
    spinner(): () => void;
    /** While set, an interrupt (Ctrl-C) calls the handler instead of exiting the CLI. */
    setCancelHandler(handler: (() => void) | undefined): void;
}

/**
 * Just enough Markdown for a terminal — headings, bold, italic, inline code, bullets, and
 * horizontal rules — so model prose doesn't read as raw `**` markup. Deliberately not a parser:
 * anything it doesn't recognise passes through untouched.
 */
export function renderMarkdownLite(text: string): string {
    return text
        .split('\n')
        .map(line => {
            if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) return paint('2', '─'.repeat(40));
            if (line.startsWith('```')) return paint('2', line);
            const heading = /^(#{1,6})\s+(.*)$/.exec(line);
            if (heading) return paint('1;4', heading[2] ?? '');
            let rendered = line.replace(/^(\s*)[-*]\s+/, '$1• ');
            rendered = rendered.replaceAll(/\*\*([^*]+)\*\*/g, (_match, inner: string) => paint('1', inner));
            rendered = rendered.replaceAll(/(?<![\w*])\*([^*]+)\*(?![\w*])/g, (_match, inner: string) => paint('3', inner));
            rendered = rendered.replaceAll(/`([^`]+)`/g, (_match, inner: string) => paint('36', inner));
            return rendered;
        })
        .join('\n');
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_WORDS = ['Pondering', 'Scheming', 'Brewing', 'Conjuring', 'Mulling', 'Percolating', 'Noodling', 'Ruminating'];

export class ReadlineUI implements HostUI {
    private readonly rl: Interface;
    /** Whether the previous output line was operational, so prose gets a separating blank line. */
    private afterMeta = false;
    /** Whether an attention block (sampling/elicitation/authorization) is open and awaiting its closing rule. */
    private inAttentionBlock = false;
    private spinnerTimer?: NodeJS.Timeout;
    private cancelHandler?: () => void;

    /** Ctrl-C cancels the in-flight tool call when one is running, and exits the CLI otherwise. */
    private readonly handleInterrupt = (): void => {
        if (this.cancelHandler) {
            this.cancelHandler();
            return;
        }
        this.rl.close();
        // eslint-disable-next-line unicorn/no-process-exit
        process.exit(130);
    };

    constructor(rl?: Interface) {
        this.rl = rl ?? createInterface({ input: process.stdin, output: process.stdout });
        this.rl.on('SIGINT', this.handleInterrupt);
        process.on('SIGINT', this.handleInterrupt);
    }

    /** Everything that isn't user input or assistant prose shares a two-space gutter and stays on one line. */
    private clipToWidth(text: string): string {
        const columns = process.stdout.columns ?? 120;
        return text.length > columns ? `${text.slice(0, Math.max(0, columns - 1))}…` : text;
    }

    private horizontalRule(): string {
        return paint('2;33', `  ${'─'.repeat(Math.max(10, Math.min(process.stdout.columns ?? 80, 100) - 2))}`);
    }

    /** If a spinner is animating, wipe its line so real output never lands next to it. */
    private clearSpinnerLine(): void {
        if (this.spinnerTimer) this.clearLine();
    }

    /** Attention blocks are framed by horizontal rules; the closing rule prints when other output resumes. */
    private closeAttentionBlock(): void {
        if (!this.inAttentionBlock) return;
        console.log(this.horizontalRule());
        this.inAttentionBlock = false;
        this.afterMeta = true;
    }

    /** The chat prompt itself also goes through the shared readline instance. */
    async readUserInput(): Promise<string> {
        this.closeAttentionBlock();
        const answer = await this.rl.question(paint('1', '\n> '));
        console.log();
        this.afterMeta = false;
        return answer.trim();
    }

    print(text: string): void {
        // The assistant's prose: rendered with just-enough Markdown at the left margin, separated
        // from any operational lines above so the conversation is easy to scan.
        this.clearSpinnerLine();
        this.closeAttentionBlock();
        if (this.afterMeta) console.log();
        console.log(renderMarkdownLite(stripAnsi(text)));
        this.afterMeta = false;
    }

    status(text: string, tone: 'info' | 'cancel' = 'info'): void {
        // Operational lines (tool calls, progress, connection events): grey italic, one line each.
        // User cancellations get a red tag so they stand out from routine chatter.
        this.clearSpinnerLine();
        this.closeAttentionBlock();
        if (tone === 'cancel') {
            console.log(`  ${paint('1;31', '[user cancellation]')} ${paint('90', this.clipToWidth(stripAnsi(text)))}`);
        } else {
            console.log(paint('3;90', this.clipToWidth(`  · ${stripAnsi(text)}`)));
        }
        this.afterMeta = true;
    }

    attention(text: string): void {
        // The user has to act on this next (elicitation form, approval): highlighted, framed by
        // horizontal rules, with the first line as the block label and the rest indented under it.
        this.clearSpinnerLine();
        if (!this.inAttentionBlock) {
            console.log(this.horizontalRule());
            this.inAttentionBlock = true;
        }
        console.log(paint('1;33', `  ${stripAnsi(text).replaceAll('\n', '\n    ')}`));
        this.afterMeta = true;
    }

    note(text: string): void {
        // Things that became part of the conversation but aren't prose (attached
        // resources, server onboarding text). Unlike status chatter these may carry
        // links the user needs whole, so they soft-wrap instead of clipping.
        this.clearSpinnerLine();
        this.closeAttentionBlock();
        console.log(paint('36', `  ▍ ${stripAnsi(text)}`));
        this.afterMeta = true;
    }

    serverLog(server: string, level: string, text: string): void {
        // Lines that originate on the server (notifications/message, child stderr) carry a tag.
        this.clearSpinnerLine();
        this.closeAttentionBlock();
        const tag = level === 'stderr' ? `[${server} stderr]` : `[${server} notification]`;
        const body = level === 'stderr' ? stripAnsi(text) : `${level}: ${stripAnsi(text)}`;
        console.log(`  ${paint('35', tag)} ${paint('90', this.clipToWidth(body))}`);
        this.afterMeta = true;
    }

    async confirm(question: string): Promise<boolean> {
        this.clearSpinnerLine();
        const raw = await this.rl.question(paint('1;33', `    ${stripAnsi(question)} [y/N] `));
        const answer = raw.trim().toLowerCase();
        this.afterMeta = true;
        return answer === 'y' || answer === 'yes';
    }

    async ask(question: string): Promise<string> {
        this.clearSpinnerLine();
        const answer = await this.rl.question(paint('1;33', `    ${stripAnsi(question)}: `));
        this.afterMeta = true;
        return answer.trim();
    }

    /** Stops the spinner and wipes its line; safe to call when no spinner is running. */
    private readonly stopSpinner = (): void => {
        if (this.spinnerTimer) clearInterval(this.spinnerTimer);
        this.spinnerTimer = undefined;
        this.clearLine();
    };

    /** Wipe the current terminal line (used to erase an in-place spinner frame). */
    private clearLine(): void {
        if (process.stdout.isTTY) process.stdout.write('\r[2K');
    }

    spinner(): () => void {
        // Animated "the model is thinking" line; redrawn in place and wiped before any real output.
        if (!process.stdout.isTTY || this.spinnerTimer) return this.stopSpinner;
        const startedAt = Date.now();
        let tick = 0;
        const render = (): void => {
            const word = SPINNER_WORDS[Math.floor((Date.now() - startedAt) / 4000) % SPINNER_WORDS.length] ?? 'Working';
            const seconds = Math.round((Date.now() - startedAt) / 1000);
            const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? '·';
            process.stdout.write(`\r[2K${paint('3;90', `  ${frame} ${word}… (${seconds}s)`)}`);
            tick++;
        };
        render();
        this.spinnerTimer = setInterval(render, 120);
        return this.stopSpinner;
    }

    setCancelHandler(handler: (() => void) | undefined): void {
        this.cancelHandler = handler;
    }

    close(): void {
        this.rl.close();
    }
}

type FormSchema = ElicitRequestFormParams['requestedSchema'];
type FormField = FormSchema['properties'][string];
type FormValue = string | number | boolean | string[];

/** Build the one-line prompt for a single elicitation form field. */
export function describeField(name: string, field: FormField, required: boolean): string {
    const pieces: string[] = [`${field.title ?? name}`];
    if (field.description) pieces.push(`(${field.description})`);
    if ('enum' in field && field.enum) pieces.push(`[options: ${field.enum.join(', ')}]`);
    if (field.type === 'boolean') pieces.push('[yes/no]');
    if ((field.type === 'number' || field.type === 'integer') && (field.minimum !== undefined || field.maximum !== undefined)) {
        pieces.push(`[${field.minimum ?? ''}..${field.maximum ?? ''}]`);
    }
    if ('default' in field && field.default !== undefined) {
        pieces.push(`[default: ${String(field.default)}]`, '(Enter for the default)');
    } else {
        pieces.push(required ? '(required)' : '(optional — Enter to skip)');
    }
    return pieces.join(' ');
}

/** Parse one raw answer according to the field's primitive type; undefined means "invalid". */
export function parseFieldAnswer(field: FormField, answer: string): FormValue | undefined {
    if (field.type === 'boolean') {
        const lowered = answer.toLowerCase();
        if (['y', 'yes', 'true'].includes(lowered)) return true;
        if (['n', 'no', 'false'].includes(lowered)) return false;
        return undefined;
    }
    if (field.type === 'number' || field.type === 'integer') {
        const value = Number(answer);
        if (Number.isNaN(value)) return undefined;
        if (field.type === 'integer' && !Number.isInteger(value)) return undefined;
        if (field.minimum !== undefined && value < field.minimum) return undefined;
        if (field.maximum !== undefined && value > field.maximum) return undefined;
        return value;
    }
    if (field.type === 'array') {
        return answer
            .split(',')
            .map(item => item.trim())
            .filter(item => item.length > 0);
    }
    if ('enum' in field && field.enum && !field.enum.includes(answer)) return undefined;
    return answer;
}

/**
 * Walk an elicitation form schema field by field, collecting answers through the UI.
 * The user can answer `decline` or `cancel` at any field; errors fail closed to cancel.
 * Note the three distinct outcomes — decline ("no") and cancel ("dismissed") are not the same.
 */
export async function collectFormInput(ui: HostUI, schema: FormSchema): Promise<ElicitResult> {
    try {
        const required = schema.required ?? [];
        const content: Record<string, FormValue> = {};
        for (const [name, field] of Object.entries(schema.properties)) {
            const isRequired = required.includes(name);
            for (let attempt = 0; attempt < 3; attempt++) {
                const answer = await ui.ask(describeField(name, field, isRequired));
                if (answer.toLowerCase() === 'decline') return { action: 'decline' };
                if (answer.toLowerCase() === 'cancel') return { action: 'cancel' };
                if (answer === '') {
                    if ('default' in field && field.default !== undefined) {
                        content[name] = field.default as FormValue;
                        break;
                    }
                    if (!isRequired) break;
                    ui.attention('this field is required (or answer "decline" / "cancel")');
                    continue;
                }
                const value = parseFieldAnswer(field, answer);
                if (value === undefined) {
                    ui.attention('invalid value, try again');
                    continue;
                }
                content[name] = value;
                break;
            }
            if (isRequired && !(name in content)) {
                // Never return an accept that violates the requested schema.
                ui.status('no valid answer for a required field — cancelling');
                return { action: 'cancel' };
            }
        }
        return { action: 'accept', content };
    } catch {
        return { action: 'cancel' };
    }
}

const BUILTIN_COMMANDS = ['/help', '/servers', '/tools', '/resources', '/prompts', '/roots', '/root add ', '/watch ', '/quit', '/exit'];

/**
 * Tab completion for the interactive CLI: slash commands and prompt names complete from the
 * connected servers' prompt lists, `@server:uri` mentions complete from their resource lists,
 * and prompt argument values complete through MCP `completion/complete` — the same data a
 * richer host would put behind its picker UI. Tab completes the common prefix; a second Tab
 * lists the remaining options (readline's standard behavior).
 */
export function createCompleter(getHost: () => McpHost | undefined): (line: string) => Promise<[string[], string]> {
    return async line => {
        try {
            const host = getHost();
            if (!host) return [[], line];

            // `@server:uri` mentions — complete the current word from the cached resource lists.
            const mention = /(^|\s)(@\S*)$/.exec(line)?.[2];
            if (mention !== undefined) {
                const candidates = [
                    ...[...host.servers.keys()].map(name => `@${name}:`),
                    ...host.listResources().map(({ server, resource }) => `@${server}:${resource.uri}`)
                ];
                return [candidates.filter(candidate => candidate.startsWith(mention)), mention];
            }

            // `/server:prompt arg=value …` — complete argument names, and argument values via completion/complete.
            const promptArgs = /^\/([^\s:]+):(\S+)\s+(?:.*\s)?([A-Za-z0-9_-]*)(=?)([^\s=]*)$/.exec(line);
            if (promptArgs) {
                const [, serverName = '', promptName = '', argumentName = '', equals = '', partial = ''] = promptArgs;
                const found = host.findPrompt(serverName, promptName);
                if (!found) return [[], line];
                if (equals === '=') {
                    const values = await host.completePromptArgument(found.server.name, found.prompt.name, argumentName, partial);
                    const suggestions = values.map(value => (/\s/.test(value) ? `${argumentName}="${value}"` : `${argumentName}=${value}`));
                    return [suggestions, `${argumentName}=${partial}`];
                }
                const names = (found.prompt.arguments ?? []).map(argument => `${argument.name}=`);
                return [names.filter(name => name.startsWith(argumentName)), argumentName];
            }

            // Slash commands and prompt commands.
            if (line.startsWith('/') && !line.includes(' ')) {
                const candidates = [...BUILTIN_COMMANDS, ...host.listPrompts().map(({ server, prompt }) => `/${server}:${prompt.name} `)];
                return [candidates.filter(candidate => candidate.startsWith(line)), line];
            }

            return [[], line];
        } catch {
            return [[], line];
        }
    };
}
