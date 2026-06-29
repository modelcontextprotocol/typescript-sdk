#!/usr/bin/env node
/**
 * The interactive entry point: a chat REPL with no built-in tools — everything comes from the
 * MCP servers in your config. Run it from the repo root:
 *
 *   pnpm --filter @mcp-examples/cli-client start                       # sibling todos-server, scripted provider
 *   ANTHROPIC_API_KEY=… pnpm --filter @mcp-examples/cli-client start -- --provider anthropic
 *   pnpm --filter @mcp-examples/cli-client start -- --config ./config.json --provider openai
 *   pnpm --filter @mcp-examples/cli-client start -- --server https://mcp.linear.app/mcp     # one ad-hoc server, OAuth if needed
 */
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import type { CliClientConfig } from './host/config';
import { configFromTargets, readConfigFile, todosServerConfig } from './host/config';
import { McpHost } from './host/host';
import { createSession, handleUserInput } from './host/loop';
import { createCompleter, ReadlineUI } from './host/ui';
import { AnthropicProvider } from './providers/anthropic';
import { GeminiProvider } from './providers/gemini';
import { OpenAIProvider } from './providers/openai';
import type { LLMProvider } from './providers/provider';
import { ScriptedProvider } from './providers/scripted';

const USAGE = `usage: tsx cli.ts [options]
  --server <target>    connect to just this server: an http(s) URL (OAuth on demand) or a stdio command line (repeatable)
  --config <path>      mcpServers config file (default: ./config.json, falling back to spawning the sibling todos-server)
  --provider <name>    scripted | anthropic | openai | gemini (default: first one with an API key in the env, else scripted)
  --model <id>         pin a model id (default: the provider's latest mid-tier model)
  --root <path>        workspace root exposed to servers via roots/list (repeatable; default: cwd)
  --callback-port <n>  fixed loopback port for the OAuth callback (default: a free port; set this when port-forwarding over SSH)
  --legacy             use the 2025 initialize handshake instead of probing for 2026-07-28
  --help               this help`;

function pickProvider(name: string | undefined, model: string | undefined): LLMProvider {
    const chosen =
        name ??
        (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
            ? 'anthropic'
            : process.env.OPENAI_API_KEY
              ? 'openai'
              : process.env.GEMINI_API_KEY
                ? 'gemini'
                : 'scripted');
    switch (chosen) {
        case 'anthropic': {
            return new AnthropicProvider(model);
        }
        case 'openai': {
            return new OpenAIProvider(model);
        }
        case 'gemini': {
            return new GeminiProvider(model);
        }
        case 'scripted': {
            return new ScriptedProvider();
        }
        default: {
            throw new Error(`Unknown provider "${chosen}" (expected scripted | anthropic | openai | gemini)`);
        }
    }
}

const { values } = parseArgs({
    // `pnpm … start -- --provider anthropic` forwards the literal `--`; drop it so only flags remain.
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    options: {
        server: { type: 'string', multiple: true },
        config: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        root: { type: 'string', multiple: true },
        'callback-port': { type: 'string' },
        legacy: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }
    }
});

if (values.help) {
    console.log(USAGE);
    process.exit(0);
}

// Tab completion needs the host's cached lists, but the host needs the UI — resolve lazily.
const hostRef: { current?: McpHost } = {};
const ui = new ReadlineUI(
    createInterface({ input: process.stdin, output: process.stdout, completer: createCompleter(() => hostRef.current) })
);
const provider = pickProvider(values.provider, values.model);

let config: CliClientConfig;
let configSource: string;
if (values.server && values.server.length > 0) {
    configSource = '--server arguments';
    config = configFromTargets(values.server);
} else if (values.config) {
    configSource = values.config;
    config = await readConfigFile(values.config);
} else if (existsSync('./config.json')) {
    configSource = './config.json';
    config = await readConfigFile('./config.json');
} else {
    configSource = 'sibling todos-server (no config.json found — see config.example.json)';
    config = todosServerConfig();
}

// Show exactly what we are about to connect to before doing it.
ui.status(`config: ${configSource}`);
for (const [serverName, entry] of Object.entries(config.mcpServers)) {
    ui.status(`  ${serverName} → ${'url' in entry ? entry.url : [entry.command, ...(entry.args ?? [])].join(' ')}`);
}

const host = new McpHost({
    ui,
    provider,
    roots: values.root ?? [process.cwd()],
    legacy: values.legacy ?? false,
    oauthCallbackPort: values['callback-port'] ? Number.parseInt(values['callback-port'], 10) : undefined
});
hostRef.current = host;
try {
    await host.connect(config);
} catch (error) {
    ui.print(error instanceof Error ? error.message : String(error));
    ui.close();
    process.exit(1);
}

if (provider.name === 'scripted') {
    ui.status(
        'provider: scripted (no API key found — replies are canned; set ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY or pass --provider)'
    );
} else {
    ui.status(`provider: ${provider.name}`);
}
ui.print('cli-client ready — say hi for a tour, /help for commands, /quit to exit.');

const chat = createSession(host, provider, ui);
try {
    for (;;) {
        const input = await ui.readUserInput();
        try {
            const result = await handleUserInput(chat, input);
            if (result === 'exit') break;
        } catch (error) {
            // A provider hiccup or a server error should cost one turn, not the whole session.
            ui.status(`error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
} finally {
    await host.close();
    ui.close();
}
