import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { CodeModeWrapper } from '../src/code-mode/index.js';
import type { DownstreamConfig } from '../src/code-mode/downstream.js';
import { StdioServerTransport } from '../src/server/stdio.js';
import type { Implementation } from '../src/types.js';

type CodeModeConfig = {
    server?: Implementation;
    downstreams: DownstreamConfig[];
};

function parseArgs(argv: string[]): string | undefined {
    for (let i = 0; i < argv.length; i += 1) {
        const current = argv[i];
        if (current === '--config' || current === '-c') {
            return argv[i + 1];
        }

        if (current?.startsWith('--config=')) {
            return current.split('=')[1];
        }
    }

    return undefined;
}

function assertDownstreamConfig(value: unknown): asserts value is DownstreamConfig[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('Config must include a non-empty "downstreams" array.');
    }

    for (const entry of value) {
        if (!entry || typeof entry !== 'object') {
            throw new Error('Invalid downstream entry.');
        }

        const { id, command, args, env, cwd } = entry as DownstreamConfig;
        if (!id || typeof id !== 'string') {
            throw new Error('Each downstream requires a string "id".');
        }

        if (!command || typeof command !== 'string') {
            throw new Error(`Downstream "${id}" is missing a "command".`);
        }

        if (args && !Array.isArray(args)) {
            throw new Error(`Downstream "${id}" has invalid "args"; expected an array.`);
        }

        if (env && typeof env !== 'object') {
            throw new Error(`Downstream "${id}" has invalid "env"; expected an object.`);
        }

        if (cwd && typeof cwd !== 'string') {
            throw new Error(`Downstream "${id}" has invalid "cwd"; expected a string.`);
        }
    }
}

async function readConfig(configPath: string): Promise<CodeModeConfig> {
    const resolved = path.resolve(process.cwd(), configPath);
    const raw = await readFile(resolved, 'utf8');
    const parsed = JSON.parse(raw);

    assertDownstreamConfig(parsed.downstreams);

    return {
        server: parsed.server,
        downstreams: parsed.downstreams
    };
}

function printUsage(): void {
    console.log('Usage: npm run code-mode -- --config ./code-mode.config.json');
}

async function main(): Promise<void> {
    const configPath = parseArgs(process.argv.slice(2));
    if (!configPath) {
        printUsage();
        process.exitCode = 1;
        return;
    }

    const config = await readConfig(configPath);
    const wrapper = new CodeModeWrapper({
        serverInfo: config.server,
        downstreams: config.downstreams
    });

    const transport = new StdioServerTransport();
    await wrapper.connect(transport);
    console.log('Code Mode wrapper is running on stdio.');

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        await wrapper.close();
    };

    process.on('SIGINT', () => {
        void shutdown().finally(() => process.exit(0));
    });

    process.on('SIGTERM', () => {
        void shutdown().finally(() => process.exit(0));
    });
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
