import type { HostUI } from '../host/ui';

/**
 * The UI used by the e2e driver: answers come from pre-loaded queues instead of a human, and
 * everything the host would have shown is recorded so the driver can assert on it afterwards.
 * Unanswered confirmations fail closed (false), like a human who walked away.
 */
export class ScriptedUI implements HostUI {
    readonly printed: string[] = [];
    readonly statuses: string[] = [];
    readonly serverLogs: Array<{ server: string; level: string; text: string }> = [];
    readonly questions: string[] = [];

    private readonly confirmAnswers: boolean[];
    private readonly askAnswers: string[];
    private cancelHandler?: () => void;
    /** When set, the next status() line that includes this substring fires the in-flight tool-call cancel handler once. */
    cancelOnStatusMatching?: string;

    constructor(options: { confirmAnswers?: boolean[]; askAnswers?: string[] } = {}) {
        this.confirmAnswers = [...(options.confirmAnswers ?? [])];
        this.askAnswers = [...(options.askAnswers ?? [])];
    }

    get unansweredConfirms(): number {
        return this.confirmAnswers.length;
    }

    get unansweredAsks(): number {
        return this.askAnswers.length;
    }

    print(text: string): void {
        this.printed.push(text);
        console.log(text);
    }

    attention(text: string): void {
        this.printed.push(text);
        console.log(text);
    }

    status(text: string): void {
        this.statuses.push(text);
        console.log(`  · ${text}`);
        if (this.cancelOnStatusMatching && text.includes(this.cancelOnStatusMatching) && this.cancelHandler) {
            this.cancelOnStatusMatching = undefined;
            this.cancelHandler();
        }
    }

    note(text: string): void {
        this.statuses.push(text);
        console.log(`  ▍ ${text}`);
    }

    serverLog(server: string, level: string, text: string): void {
        this.serverLogs.push({ server, level, text });
        console.log(`  [${server}] ${level}: ${text}`);
    }

    confirm(question: string): Promise<boolean> {
        this.questions.push(question);
        return Promise.resolve(this.confirmAnswers.shift() ?? false);
    }

    ask(question: string): Promise<string> {
        this.questions.push(question);
        return Promise.resolve(this.askAnswers.shift() ?? '');
    }

    spinner(): () => void {
        return noop;
    }

    setCancelHandler(handler: (() => void) | undefined): void {
        this.cancelHandler = handler;
    }
}

function noop(): void {
    // The scripted driver has no spinner to stop.
}
