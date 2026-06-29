import { readFile } from 'node:fs/promises';

import { siblingPath } from '@mcp-examples/shared';
import * as z from 'zod/v4';

/**
 * The standard `mcpServers` config shape (the same one Claude Desktop, Claude Code, and most
 * other hosts read): stdio servers are spawned from `command`/`args`, remote servers are
 * reached via `url`. Anything you list here is code/infrastructure you trust — adding a
 * server means trusting it with whatever the model sends it.
 */
const stdioServerSchema = z.object({
    command: z.string(),
    args: z.array(z.string()).optional(),
    /** Extra environment for the spawned server. Children do NOT inherit the host's env. */
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional()
});

const httpServerSchema = z.object({
    url: z.string(),
    /** Static headers (e.g. `Authorization: Bearer ${MY_TOKEN}`); `${VAR}` reads from the host env. */
    headers: z.record(z.string(), z.string()).optional()
});

const configSchema = z.object({
    mcpServers: z.record(z.string(), z.union([stdioServerSchema, httpServerSchema]))
});

export type StdioServerConfig = z.infer<typeof stdioServerSchema>;
export type HttpServerConfig = z.infer<typeof httpServerSchema>;
export type ServerConfig = StdioServerConfig | HttpServerConfig;
export type CliClientConfig = z.infer<typeof configSchema>;

export function isHttpServer(config: ServerConfig): config is HttpServerConfig {
    return 'url' in config;
}

/**
 * Replace `${VAR}` references with values from the environment, so secrets live in env vars
 * rather than in the config file. Unknown variables resolve to ''.
 */
export function interpolateEnv(value: string, env: Record<string, string | undefined> = process.env): string {
    return value.replaceAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => env[name] ?? '');
}

export function parseConfig(json: string, env: Record<string, string | undefined> = process.env): CliClientConfig {
    const parsed = configSchema.parse(JSON.parse(json));
    for (const entry of Object.values(parsed.mcpServers)) {
        if (isHttpServer(entry)) {
            entry.url = interpolateEnv(entry.url, env);
            if (entry.headers) {
                for (const [header, value] of Object.entries(entry.headers)) {
                    entry.headers[header] = interpolateEnv(value, env);
                }
            }
        } else if (entry.env) {
            for (const [name, value] of Object.entries(entry.env)) {
                entry.env[name] = interpolateEnv(value, env);
            }
        }
    }
    return parsed;
}

export async function readConfigFile(path: string): Promise<CliClientConfig> {
    return parseConfig(await readFile(path, 'utf8'));
}

/** The zero-setup default: spawn the sibling todos-server over stdio. */
export function todosServerConfig(): CliClientConfig {
    return {
        mcpServers: {
            todos: {
                command: 'npx',
                args: ['-y', 'tsx', siblingPath(import.meta.url, '../../todos-server/server.ts')]
            }
        }
    };
}

/** Derive a friendly server name from an ad-hoc `--server` URL (mcp.linear.app → "linear"). */
function serverNameFromUrl(url: URL): string {
    const generic = new Set(['mcp', 'www', 'api', 'app', 'dev', 'com', 'io', 'net', 'org', 'ai', 'run', 'co']);
    const meaningful = url.hostname.split('.').find(label => !generic.has(label));
    return meaningful ?? url.hostname;
}

/** Derive a friendly server name from an ad-hoc `--server` command line ("npx -y tsx server.ts" → "server"). */
function serverNameFromCommand(tokens: string[]): string {
    const last = tokens.at(-1) ?? 'server';
    const base = last.split(/[/\\]/).pop() ?? last;
    return base.replace(/\.[A-Za-z]+$/, '') || 'server';
}

/**
 * Build a config from ad-hoc `--server` arguments: http(s) URLs become Streamable HTTP entries
 * (the OAuth flow starts on demand if the server answers 401), anything else is treated as a
 * stdio command line to spawn.
 */
export function configFromTargets(targets: string[]): CliClientConfig {
    const mcpServers: Record<string, ServerConfig> = {};
    const claim = (name: string, index: number): string => (mcpServers[name] === undefined ? name : `${name}_${index + 1}`);
    for (const [index, target] of targets.entries()) {
        if (/^https?:\/\//i.test(target)) {
            mcpServers[claim(serverNameFromUrl(new URL(target)), index)] = { url: target };
        } else {
            const [command, ...args] = target.split(/\s+/).filter(token => token.length > 0);
            if (!command) throw new Error('--server got an empty target');
            mcpServers[claim(serverNameFromCommand([command, ...args]), index)] = { command, args };
        }
    }
    if (Object.keys(mcpServers).length === 0) throw new Error('--server needs at least one URL or command line');
    return { mcpServers };
}
