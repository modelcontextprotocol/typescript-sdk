// Run with:
//   pnpm --filter @modelcontextprotocol/examples-client exec tsx src/groupsExampleClient.ts
//
// This example spawns the matching stdio server by default. To point at a different stdio server:
//   pnpm --filter @modelcontextprotocol/examples-client exec tsx src/groupsExampleClient.ts --server-command <cmd> --server-args "..."

import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import type { Group } from '@modelcontextprotocol/client';
import { Client, GROUPS_META_KEY, StdioClientTransport } from '@modelcontextprotocol/client';

type GroupName = string;

function parseGroupList(input: string): string[] {
    return input
        .split(/[\s,]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

function groupMembership(meta: unknown): string[] {
    if (!meta || typeof meta !== 'object') {
        return [];
    }

    const record = meta as Record<string, unknown>;
    const value = record[GROUPS_META_KEY];
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((v): v is string => typeof v === 'string');
}

function buildParentToChildrenMap(groups: Group[]): Map<GroupName, Set<GroupName>> {
    const map = new Map<GroupName, Set<GroupName>>();

    for (const group of groups) {
        const parents = groupMembership(group._meta);
        for (const parent of parents) {
            if (!map.has(parent)) {
                map.set(parent, new Set());
            }
            map.get(parent)!.add(group.name);
        }
    }

    return map;
}

function expandWithDescendants(selected: string[], parentToChildren: Map<GroupName, Set<GroupName>>): Set<GroupName> {
    const out = new Set<GroupName>();
    const queue: GroupName[] = [];

    for (const g of selected) {
        if (!out.has(g)) {
            out.add(g);
            queue.push(g);
        }
    }

    while (queue.length > 0) {
        const current = queue.shift()!;
        const children = parentToChildren.get(current);
        if (!children) {
            continue;
        }
        for (const child of children) {
            if (!out.has(child)) {
                out.add(child);
                queue.push(child);
            }
        }
    }

    return out;
}

function expandDescendantsExcludingSelf(selected: string[], parentToChildren: Map<GroupName, Set<GroupName>>): Set<GroupName> {
    const out = new Set<GroupName>();
    const queue: GroupName[] = [];

    for (const g of selected) {
        const children = parentToChildren.get(g);
        // Only list groups that are *contained by* the user-entered group(s).
        // If a user enters a leaf group, it contains nothing, so it should not appear in the output.
        if (!children || children.size === 0) {
            continue;
        }

        for (const child of children) {
            if (!out.has(child)) {
                out.add(child);
                queue.push(child);
            }
        }
    }

    while (queue.length > 0) {
        const current = queue.shift()!;
        const children = parentToChildren.get(current);
        if (!children) {
            continue;
        }
        for (const child of children) {
            if (!out.has(child)) {
                out.add(child);
                queue.push(child);
            }
        }
    }

    return out;
}

function formatBulletList(items: Array<{ name: string; description?: string }>): string {
    if (items.length === 0) {
        return '(none)';
    }

    return items
        .map(i => {
            const desc = i.description ? ` — ${i.description}` : '';
            return `- ${i.name}${desc}`;
        })
        .join('\n');
}

function printHelp() {
    console.log('\nCommands:');
    console.log(' all (a)                 List all groups, tools, resources, and prompts');
    console.log(' groups (g/enter)        List available groups ');
    console.log(' help (h)                Show this help');
    console.log(' exit (e)                Quit');
    console.log(' <groups...>             Filter by one or more groups (comma or space-separated)');
}

function parseArgs(argv: string[]) {
    const parsed: { serverCommand?: string; serverArgs?: string[] } = {};

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--server-command' && argv[i + 1]) {
            parsed.serverCommand = argv[i + 1]!;
            i++;
            continue;
        }
        if (arg === '--server-args' && argv[i + 1]) {
            // A single string that will be split on whitespace. Intended for simple use.
            parsed.serverArgs = argv[i + 1]!.split(/\s+/).filter(Boolean);
            i++;
            continue;
        }
    }

    return parsed;
}

async function run(): Promise<void> {
    const argv = process.argv.slice(2);
    const options = parseArgs(argv);

    const thisFile = fileURLToPath(import.meta.url);
    const clientSrcDir = path.dirname(thisFile);
    const clientPkgDir = path.resolve(clientSrcDir, '..');
    const defaultServerScript = path.resolve(clientPkgDir, '..', 'server', 'src', 'groupsExample.ts');

    const serverCommand = options.serverCommand ?? 'pnpm';
    const serverArgs = options.serverArgs ?? ['tsx', defaultServerScript];

    console.log('=======================');
    console.log('Groups filtering client');
    console.log('=======================');
    console.log(`Starting stdio server: ${serverCommand} ${serverArgs.join(' ')}`);

    const transport = new StdioClientTransport({
        command: serverCommand,
        args: serverArgs,
        cwd: clientPkgDir,
        stderr: 'inherit'
    });

    const client = new Client({ name: 'groups-example-client', version: '1.0.0' });
    await client.connect(transport);

    const [groupsResult, toolsResult, resourcesResult, promptsResult] = await Promise.all([
        client.listGroups(),
        client.listTools(),
        client.listResources(),
        client.listPrompts()
    ]);

    const groups = groupsResult.groups;
    const tools = toolsResult.tools;
    const resources = resourcesResult.resources;
    const prompts = promptsResult.prompts;

    const groupNames = new Set(groups.map(g => g.name));
    const parentToChildren = buildParentToChildrenMap(groups);

    console.log(`\nFetched: ${groups.length} groups, ${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts.`);
    console.log(`Available groups: ${[...groupNames].sort().join(', ')}`);

    const rl = createInterface({ input: process.stdin, output: process.stdout });

    const question = (prompt: string) =>
        new Promise<string>(resolve => {
            rl.question(prompt, answer => resolve(answer.trim()));
        });

    printHelp();

    while (true) {
        let input = await question('\nEnter a command or a list of groups to filter by: ');
        if (!input) {
            input = 'groups';
        }

        const lower = input.toLowerCase();

        // Handle all command
        if (lower === 'all' || lower === 'a') {
            const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name));
            const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));
            const sortedResources = [...resources].sort((a, b) => a.name.localeCompare(b.name));
            const sortedPrompts = [...prompts].sort((a, b) => a.name.localeCompare(b.name));

            console.log('\nGroups:');
            console.log(formatBulletList(sortedGroups.map(g => ({ name: g.name, description: g.description }))));

            console.log('\nTools:');
            console.log(formatBulletList(sortedTools.map(t => ({ name: t.name, description: t.description }))));

            console.log('\nResources:');
            console.log(formatBulletList(sortedResources.map(r => ({ name: r.name, description: r.description }))));

            console.log('\nPrompts:');
            console.log(formatBulletList(sortedPrompts.map(p => ({ name: p.name, description: p.description }))));
            continue;
        }

        // Handle list command
        if (lower === 'groups' || lower === 'g') {
            const sortedGroups = [...groups].sort((a, b) => a.name.localeCompare(b.name));
            console.log('\nGroups:');
            console.log(formatBulletList(sortedGroups.map(g => ({ name: g.name, description: g.description }))));
            continue;
        }

        // Handle help command
        if (lower === 'help' || lower === 'h' || lower === '?') {
            printHelp();
            continue;
        }

        // Handle quit command
        if (lower === 'quit' || lower === 'q') {
            rl.close();
            await client.close();
            process.exit();
        }

        // Handle a group list
        const requested = parseGroupList(input);
        const unknown = requested.filter(g => !groupNames.has(g));
        if (unknown.length > 0) {
            console.log(`Unknown group(s): ${unknown.join(', ')}`);
        }

        const validRequested = requested.filter(g => groupNames.has(g));
        if (validRequested.length === 0) {
            console.log('No valid groups provided. Type "list" to see available groups.');
            continue;
        }

        const selected = expandWithDescendants(validRequested, parentToChildren);
        const groupsToList = expandDescendantsExcludingSelf(validRequested, parentToChildren);

        const selectedGroups = groups.filter(g => groupsToList.has(g.name)).sort((a, b) => a.name.localeCompare(b.name));

        const selectedTools = tools
            .filter(t => groupMembership(t._meta).some(g => selected.has(g)))
            .sort((a, b) => a.name.localeCompare(b.name));

        const selectedResources = resources
            .filter(r => groupMembership(r._meta).some(g => selected.has(g)))
            .sort((a, b) => a.name.localeCompare(b.name));

        const selectedPrompts = prompts
            .filter(p => groupMembership(p._meta).some(g => selected.has(g)))
            .sort((a, b) => a.name.localeCompare(b.name));

        console.log('\nGroups:');
        console.log(formatBulletList(selectedGroups.map(g => ({ name: g.name, description: g.description }))));

        console.log('\nTools:');
        console.log(formatBulletList(selectedTools.map(t => ({ name: t.name, description: t.description }))));

        console.log('\nResources:');
        console.log(formatBulletList(selectedResources.map(r => ({ name: r.name, description: r.description }))));

        console.log('\nPrompts:');
        console.log(formatBulletList(selectedPrompts.map(p => ({ name: p.name, description: p.description }))));
    }
}

run().catch(error => {
    console.error('Client error:', error);
    process.exit(1);
});
