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

/**
 * Parse a user-entered group list.
 *
 * Accepts either comma-separated or whitespace-separated input (or a mix of both), e.g.:
 * - `communications, work`
 * - `communications work`
 */
function parseGroupList(input: string): string[] {
    return input
        .split(/[\s,]+/)
        .map(s => s.trim())
        .filter(Boolean);
}

/**
 * Extracts group membership from a primitive's `_meta` object.
 *
 * The MCP groups proposal uses `_meta[GROUPS_META_KEY]` to store a list of group names.
 * - If `_meta` is missing or malformed, this returns `[]`.
 * - Non-string entries are ignored.
 */
function groupMembership(meta: unknown): string[] {
    // `_meta` is defined as an open-ended metadata object on primitives, but it may be:
    // - missing entirely
    // - `null`
    // - some other non-object value
    // In all of those cases we treat it as “no group membership information available”
    if (!meta || typeof meta !== 'object') {
        return [];
    }

    // We only need dictionary-style access (`record[key]`), so we cast to a generic record.
    // This is intentionally tolerant: the server may include other meta keys we don't know about.
    const record = meta as Record<string, unknown>;

    // The groups proposal stores membership at `_meta[GROUPS_META_KEY]`.
    // Convention:
    // - For tools/resources/prompts: list of groups that primitive belongs to.
    // - For groups themselves: list of parent groups that *contain* this group.
    const value = record[GROUPS_META_KEY];
    if (!Array.isArray(value)) {
        return [];
    }

    // Be defensive: only keep string entries (ignore malformed values like numbers/objects).
    return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Builds a directed adjacency map from parent group -> child groups.
 *
 * In this proposal, *child* groups declare their parent group(s) via `_meta[GROUPS_META_KEY]`.
 * So we invert that relationship into a `parentToChildren` map to make traversal easier.
 */
function buildParentToChildrenMap(groups: Group[]): Map<GroupName, Set<GroupName>> {
    const map = new Map<GroupName, Set<GroupName>>();

    for (const group of groups) {
        // Each *child* group declares its parent group(s) via `_meta[GROUPS_META_KEY]`.
        // Example: if group `email` has `_meta[GROUPS_META_KEY]=['communications']`, then
        // `communications` *contains* `email`.
        const parents = groupMembership(group._meta);
        for (const parent of parents) {
            // Build an adjacency list (parent -> children) so we can traverse “down” the graph.
            // We store children in a Set to:
            // - naturally dedupe if the server repeats membership
            // - avoid multiple queue entries later during traversal
            if (!map.has(parent)) {
                map.set(parent, new Set());
            }
            map.get(parent)!.add(group.name);
        }
    }

    return map;
}

/**
 * Returns every group name the client should consider during traversal.
 *
 * Some parent nodes may exist only as names referenced by children (i.e., appear in `_meta`)
 * even if the server doesn't explicitly return them as `Group` objects.
 */
function allKnownGroupNames(groups: Group[], parentToChildren: Map<GroupName, Set<GroupName>>): Set<GroupName> {
    const names = new Set<GroupName>();

    for (const g of groups) {
        names.add(g.name);
    }
    for (const parent of parentToChildren.keys()) {
        names.add(parent);
    }

    return names;
}

/**
 * Maximum descendant depth in *edges* found in the group graph.
 *
 * Example:
 * - A leaf group has depth 0.
 * - A parent with direct children has depth 1.
 *
 * Cycles are handled by refusing to evaluate a group already on the current path.
 */
function computeMaxDepthEdges(allGroups: Iterable<GroupName>, parentToChildren: Map<GroupName, Set<GroupName>>): number {
    // We want a *global* maximum nesting depth to validate the user's `depth` setting.
    // This is a graph problem (not necessarily a tree): a child can have multiple parents.
    //
    // We compute “depth in edges” rather than “depth in nodes”:
    // - leaf = 0
    // - parent -> child = 1
    // This aligns cleanly with traversal where each step consumes one edge.
    const memo = new Map<GroupName, number>();

    const dfs = (node: GroupName, path: Set<GroupName>): number => {
        // Memoization: once we've computed the best descendant depth for a node,
        // we can reuse it across different starting points.
        const cached = memo.get(node);
        if (cached !== undefined) {
            return cached;
        }

        // Cycle safety: group graphs *should* be acyclic, but we must not assume that.
        // If we re-enter a node already on the current recursion path, treat it as a leaf
        // for the purpose of depth calculation and stop descending.
        if (path.has(node)) {
            return 0;
        }

        // Track the active DFS stack so we can detect cycles specific to this path.
        path.add(node);
        const children = parentToChildren.get(node);
        let best = 0;
        if (children) {
            for (const child of children) {
                // If a direct child is already on the active path, we'd form a cycle.
                // Skip it; other children may still extend depth.
                if (path.has(child)) {
                    continue;
                }

                // “1 + dfs(child)” accounts for the edge from `node` to `child`.
                best = Math.max(best, 1 + dfs(child, path));
            }
        }

        // Pop from recursion stack before returning to the caller.
        path.delete(node);

        // Cache the computed best depth for this node.
        memo.set(node, best);
        return best;
    };

    // Some parent groups might only exist as names referenced in `_meta` and not as full `Group` objects.
    // That's why the caller passes `allGroups` rather than just `groups.map(g => g.name)`.
    let max = 0;
    for (const g of allGroups) {
        max = Math.max(max, dfs(g, new Set<GroupName>()));
    }
    return max;
}

/**
 * Expands selected groups through the group graph up to a maximum number of edges.
 *
 * This function is intentionally:
 * - **depth-limited**: `depthEdges` controls how far to traverse (in edges)
 * - **cycle-safe**: a `visited` set prevents re-processing the same group and avoids loops
 *
 * `includeSelf` controls whether the returned set contains the starting groups.
 * For this CLI's output, we typically exclude the requested groups from the displayed
 * “Groups” section (a group doesn't “contain itself”).
 */
function expandWithinDepth(
    selected: string[],
    parentToChildren: Map<GroupName, Set<GroupName>>,
    depthEdges: number,
    includeSelf: boolean
): Set<GroupName> {
    // `out` accumulates the groups we will return.
    const out = new Set<GroupName>();

    // `visited` ensures we evaluate any group at most once. This makes traversal:
    // - cycle-safe (won't loop forever)
    // - efficient (won't expand the same subgraph repeatedly)
    const visited = new Set<GroupName>();

    // We do a breadth-first traversal so “remaining depth” is easy to manage.
    // Each queue item carries how many edges are still allowed from that node.
    const queue: Array<{ name: GroupName; remaining: number }> = [];

    for (const g of selected) {
        // Optionally include the selected group(s) themselves.
        // For the CLI's “Groups” section we usually exclude these so a group doesn't “contain itself”.
        if (includeSelf) {
            out.add(g);
        }

        // Seed traversal from each selected group, but only once per unique group.
        if (!visited.has(g)) {
            visited.add(g);
            queue.push({ name: g, remaining: depthEdges });
        }
    }

    while (queue.length > 0) {
        // Take the next node to expand.
        const { name: current, remaining } = queue.shift()!;

        // No remaining budget means we stop expanding children from this node.
        if (remaining <= 0) {
            continue;
        }

        const children = parentToChildren.get(current);

        // Missing entry means the node is a leaf (or unknown to our graph). Nothing to expand.
        if (!children) {
            continue;
        }
        for (const child of children) {
            // A contained group is always included in the output set.
            out.add(child);

            // Only enqueue the child if we haven't expanded it already.
            // Note: we still add `child` to `out` even if visited, because it may be a child
            // of multiple parents and should appear as “contained” regardless.
            if (!visited.has(child)) {
                visited.add(child);
                queue.push({ name: child, remaining: remaining - 1 });
            }
        }
    }

    if (!includeSelf) {
        // A second safety-net: even if traversal re-adds a selected group through an unusual
        // cyclic or multi-parent configuration, ensure we don't list requested groups as “contained”.
        for (const g of selected) {
            out.delete(g);
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
    console.log(' depth (d) [n]           Show or set group display depth (1..max)');
    console.log(' groups (g/enter)        List available groups ');
    console.log(' help (h)                Show this help');
    console.log(' exit (e/quit/q)         Quit');
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
    // ---- Process command-line args ----------------------------------------------------------
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

    // ---- Fetch primitives up-front ---------------------------------------------------------
    // This example intentionally fetches *all* groups/tools/resources/prompts once at startup.
    // The filtering is then performed locally, to demonstrate how a client could build UI
    // affordances (search, filters) on top of the server's raw primitive lists.
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

    // ---- Build the group graph --------------------------------------------------------------
    // We treat group membership on a Group's `_meta[GROUPS_META_KEY]` as “this group is contained
    // by the listed parent group(s)”. That lets us build `parentToChildren` for traversal.
    const groupNames = new Set(groups.map(g => g.name));
    const parentToChildren = buildParentToChildrenMap(groups);
    const knownGroupNames = allKnownGroupNames(groups, parentToChildren);

    // Compute the maximum nesting in the fetched graph so we can validate user-provided depth.
    // Note: `computeMaxDepthEdges` counts *edges* (leaf=0, parent->child=1). For a user-facing
    // “display depth” we allow one extra level so users can include the deepest group's contents.
    const maxDepthEdges = computeMaxDepthEdges(knownGroupNames, parentToChildren);
    // User-facing depth includes one extra level so users can choose to include the deepest group's contents.
    // Example: if max edge depth is 1 (parent -> child), allow depth up to 2.
    const maxDepth = Math.max(1, maxDepthEdges + 1);
    let currentDepth = maxDepth;

    console.log(`\nFetched: ${groups.length} groups, ${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts.`);
    console.log(`Available groups: ${[...groupNames].toSorted().join(', ')}`);
    console.log(`Group display depth: ${currentDepth} (max: ${maxDepth})`);

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

        // ---- Command: all ------------------------------------------------------------------
        // Show everything, without any local filtering.
        if (lower === 'all' || lower === 'a') {
            const sortedGroups = [...groups].toSorted((a, b) => a.name.localeCompare(b.name));
            const sortedTools = [...tools].toSorted((a, b) => a.name.localeCompare(b.name));
            const sortedResources = [...resources].toSorted((a, b) => a.name.localeCompare(b.name));
            const sortedPrompts = [...prompts].toSorted((a, b) => a.name.localeCompare(b.name));

            if (sortedGroups.length > 0) console.log('\nGroups:');
            console.log(formatBulletList(sortedGroups.map(g => ({ name: g.name, description: g.description }))));

            if (sortedTools.length > 0) console.log('\nTools:');
            console.log(formatBulletList(sortedTools.map(t => ({ name: t.name, description: t.description }))));

            if (sortedResources.length > 0) console.log('\nResources:');
            console.log(formatBulletList(sortedResources.map(r => ({ name: r.name, description: r.description }))));

            if (sortedPrompts.length > 0) console.log('\nPrompts:');
            console.log(formatBulletList(sortedPrompts.map(p => ({ name: p.name, description: p.description }))));
            continue;
        }

        // ---- Command: groups ----------------------------------------------------------------
        // List all available groups returned by the server.
        if (lower === 'groups' || lower === 'g') {
            const sortedGroups = [...groups].toSorted((a, b) => a.name.localeCompare(b.name));
            console.log('\nGroups:');
            console.log(formatBulletList(sortedGroups.map(g => ({ name: g.name, description: g.description }))));
            continue;
        }

        // ---- Command: depth -----------------------------------------------------------------
        // Controls how far group traversal expands.
        // - depth=1: show only immediate children in the “Groups” output, and do NOT include
        //   the children's tools/resources/prompts.
        // - depth=2: show children, and include the children's tools/resources/prompts.
        if (lower === 'depth' || lower === 'd' || lower.startsWith('depth ') || lower.startsWith('d ')) {
            const parts = input.split(/\s+/).filter(Boolean);
            if (parts.length === 1) {
                console.log(`Current depth: ${currentDepth} (max: ${maxDepth})`);
                continue;
            }

            const next = Number.parseInt(parts[1]!, 10);
            if (!Number.isFinite(next) || Number.isNaN(next)) {
                console.log('Usage: depth [n]  (n must be an integer)');
                continue;
            }
            if (next < 1 || next > maxDepth) {
                console.log(`Depth must be between 1 and ${maxDepth}.`);
                continue;
            }

            currentDepth = next;
            console.log(`Group display depth set to ${currentDepth} (max: ${maxDepth}).`);
            continue;
        }

        // ---- Command: help ------------------------------------------------------------------
        if (lower === 'help' || lower === 'h' || lower === '?') {
            printHelp();
            continue;
        }

        // ---- Command: exit ------------------------------------------------------------------
        if (lower === 'exit' || lower === 'e' || lower === 'quit' || lower === 'q') {
            rl.close();
            await client.close();
            throw new Error('User quit');
        }

        // ---- Treat input as a group list ----------------------------------------------------
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

        // ---- Depth semantics (important) ----------------------------------------------------
        // We compute TWO different sets:
        // 1) `groupsToList`: groups that are *contained by* the requested groups, up to `currentDepth`.
        //    - Excludes the requested group(s) themselves.
        // 2) `includedForContents`: groups whose contents (tools/resources/prompts) are included.
        //    - Includes the requested group(s) themselves.
        //    - Traverses only `currentDepth - 1` edges so that `depth=1` doesn't include child contents.
        const groupsToList = expandWithinDepth(validRequested, parentToChildren, currentDepth, false);
        const includedForContents = expandWithinDepth(validRequested, parentToChildren, Math.max(0, currentDepth - 1), true);

        const selectedGroups = groups.filter(g => groupsToList.has(g.name)).toSorted((a, b) => a.name.localeCompare(b.name));

        const selectedTools = tools
            .filter(t => groupMembership(t._meta).some(g => includedForContents.has(g)))
            .toSorted((a, b) => a.name.localeCompare(b.name));

        const selectedResources = resources
            .filter(r => groupMembership(r._meta).some(g => includedForContents.has(g)))
            .toSorted((a, b) => a.name.localeCompare(b.name));

        const selectedPrompts = prompts
            .filter(p => groupMembership(p._meta).some(g => includedForContents.has(g)))
            .toSorted((a, b) => a.name.localeCompare(b.name));

        if (selectedGroups.length > 0) console.log('\nGroups:');
        console.log(formatBulletList(selectedGroups.map(g => ({ name: g.name, description: g.description }))));

        if (selectedTools.length > 0) console.log('\nTools:');
        console.log(formatBulletList(selectedTools.map(t => ({ name: t.name, description: t.description }))));

        if (selectedResources.length > 0) console.log('\nResources:');
        console.log(formatBulletList(selectedResources.map(r => ({ name: r.name, description: r.description }))));

        if (selectedPrompts.length > 0) console.log('\nPrompts:');
        console.log(formatBulletList(selectedPrompts.map(p => ({ name: p.name, description: p.description }))));
    }
}

await run();
