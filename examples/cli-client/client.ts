/**
 * The CI entry point: replays the scripted conversation in script/session.ts against the
 * sibling todos-server with the keyless ScriptedProvider, asserting at every step. This is
 * what `pnpm run:examples` executes over the stdio and Streamable HTTP legs; run it yourself
 * with `pnpm --filter @mcp-examples/cli-client client`. The interactive entry for humans is
 * cli.ts (`pnpm --filter @mcp-examples/cli-client start`).
 */
import { parseExampleArgs, siblingPath } from '@mcp-examples/shared';

import type { CliClientConfig } from './host/config';
import { McpHost } from './host/host';
import { createSession, handleUserInput } from './host/loop';
import { ScriptedProvider } from './providers/scripted';
import { ScriptedUI } from './script/scriptedUi';
import { buildScriptedSession } from './script/session';

const { transport, url, era } = parseExampleArgs();

// Push-style server→client requests (2025-era sampling/elicitation) have no return path on a
// stateless legacy HTTP deployment, so that leg skips the prioritize/clear_done steps and
// still exercises tools, resources-as-context, and prompts.
const interactive = !(era === 'legacy' && transport === 'http');

const session = buildScriptedSession({ interactive });
const ui = new ScriptedUI({ confirmAnswers: session.confirmAnswers, askAnswers: session.askAnswers });
const provider = new ScriptedProvider(session.turns);
const host = new McpHost({ ui, provider, roots: [process.cwd()], legacy: era === 'legacy' });

const config: CliClientConfig =
    transport === 'stdio'
        ? { mcpServers: { todos: { command: 'npx', args: ['-y', 'tsx', siblingPath(import.meta.url, '../todos-server/server.ts')] } } }
        : { mcpServers: { todos: { url } } };

await host.connect(config);

const chat = createSession(host, provider, ui);
for (const [index, input] of session.inputs.entries()) {
    session.beforeInput?.[index]?.(ui);
    await handleUserInput(chat, input);
}

// Give debounced list-change refreshes (the SDK coalesces them for ~300 ms) a moment to land.
await new Promise(resolve => setTimeout(resolve, 750));

await session.verify({ ui, provider, host, era, transport });
await host.close();

console.log('cli-client e2e: all checks passed');
