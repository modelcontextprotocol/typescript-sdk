/**
 * GitHub — MCP Events server (production-ready).
 *
 * Exposes GitHub `pull_request` and `workflow_run` webhook deliveries as MCP
 * events. An embedded HTTP listener receives signed webhook POSTs from GitHub,
 * verifies the `X-Hub-Signature-256` HMAC via `@octokit/webhooks`, strips the
 * fat payload (>100KB for PRs) to a minimal projection, and broadcasts via
 * `server.emitEvent()`. Poll-mode clients see the same events through
 * `buffer`; push/webhook clients receive them in real time. Subscribers
 * may filter by repo and by action/conclusion sub-type.
 *
 * ## Setup
 *
 * 1. Expose a public URL: `cloudflared tunnel --url http://localhost:3000`
 * 2. In your GitHub repo → Settings → Webhooks → Add webhook
 * 3. Payload URL: `<your-tunnel-url>/github/webhook`
 * 4. Content type: `application/json`
 * 5. Secret: generate one (e.g. `openssl rand -hex 32`) and set it as
 *    `GITHUB_WEBHOOK_SECRET`
 * 6. Events: select **Pull requests** and **Workflow runs**
 *
 * ## Environment variables
 *
 * | Name                    | Required | Description                                            |
 * | ----------------------- | -------- | ------------------------------------------------------ |
 * | `GITHUB_WEBHOOK_SECRET` | yes      | Shared secret for X-Hub-Signature-256 HMAC validation  |
 * | `PORT`                  | no       | Port for the inbound webhook listener (default `3000`) |
 *
 * ## Run
 *
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/events-stress/github.ts
 */

import { createServer as createHttpServer } from 'node:http';

import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import { createNodeMiddleware, Webhooks } from '@octokit/webhooks';
import * as z from 'zod/v4';

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

// --- Payload schemas: the MINIMAL projection we forward downstream ----------

const prActions = ['opened', 'closed', 'synchronize', 'reopened'] as const;
type PrAction = (typeof prActions)[number];

const prPayload = z.object({
    action: z.enum(prActions),
    number: z.number(),
    repo: z.string(),
    title: z.string(),
    author: z.string(),
    url: z.string(),
    merged: z.boolean().optional()
});

const wfActions = ['requested', 'in_progress', 'completed'] as const;

const wfPayload = z.object({
    action: z.enum(wfActions),
    repo: z.string(),
    workflowName: z.string(),
    runId: z.number(),
    conclusion: z.string().nullable(),
    url: z.string()
});

// --- Server -----------------------------------------------------------------

export function createServer(webhooksOverride?: Webhooks): McpServer {
    const secret = webhooksOverride ? 'test-override' : requireEnv('GITHUB_WEBHOOK_SECRET');
    const webhooks = webhooksOverride ?? new Webhooks({ secret });

    const server = new McpServer({ name: 'github-events', version: '1.0.0' }, { events: { push: { heartbeatIntervalMs: 15_000 } } });

    server.registerEvent(
        'github.pull_request',
        {
            description: 'Fires on GitHub pull_request webhook deliveries',
            inputSchema: z.object({
                repo: z.string().optional().describe('owner/name filter, e.g. "octocat/hello-world"'),
                actions: z.array(z.enum(prActions)).optional().describe('subset of PR actions to receive')
            }),
            payloadSchema: prPayload,
            matches: (params, data) => {
                const d = data as z.infer<typeof prPayload>;
                if (params.repo && params.repo !== d.repo) return false;
                if (params.actions && !params.actions.includes(d.action)) return false;
                return true;
            },
            buffer: { capacity: 1000 }
        },
        // emit-only: check callback is inert; buffer surfaces emits to poll.
        async () => ({ events: [], cursor: 'emit-only', nextPollSeconds: 30 })
    );

    server.registerEvent(
        'github.workflow_run',
        {
            description: 'Fires on GitHub workflow_run webhook deliveries',
            inputSchema: z.object({
                repo: z.string().optional().describe('owner/name filter'),
                conclusion: z.enum(['success', 'failure', 'cancelled']).optional()
            }),
            payloadSchema: wfPayload,
            matches: (params, data) => {
                const d = data as z.infer<typeof wfPayload>;
                if (params.repo && params.repo !== d.repo) return false;
                if (params.conclusion && params.conclusion !== d.conclusion) return false;
                return true;
            },
            buffer: { capacity: 1000 }
        },
        async () => ({ events: [], cursor: 'emit-only', nextPollSeconds: 30 })
    );

    // --- Webhook handlers: strip fat payload, emit minimal projection ---------
    // GitHub PR payloads routinely exceed 100KB (diff_url, patch, commits,
    // review_comments, ...). We forward only the fields clients care about.

    webhooks.on('pull_request', ({ payload }) => {
        const action = payload.action as PrAction;
        if (!prActions.includes(action)) return; // ignore labeled, assigned, etc.
        server.emitEvent('github.pull_request', {
            action,
            number: payload.number,
            repo: payload.repository.full_name,
            title: payload.pull_request.title,
            author: payload.pull_request.user?.login ?? 'ghost',
            url: payload.pull_request.html_url,
            merged: action === 'closed' ? (payload.pull_request.merged ?? false) : undefined
        });
    });

    webhooks.on('workflow_run', ({ payload }) => {
        server.emitEvent('github.workflow_run', {
            action: payload.action,
            repo: payload.repository.full_name,
            workflowName: payload.workflow_run.name,
            runId: payload.workflow_run.id,
            conclusion: payload.workflow_run.conclusion,
            url: payload.workflow_run.html_url
        });
    });

    webhooks.onError(err => {
        console.error('[github-events] webhook handler error:', err.message);
    });

    // --- Inbound HTTP listener ------------------------------------------------
    // `createNodeMiddleware` handles raw-body buffering and
    // `webhooks.verifyAndReceive()` (X-Hub-Signature-256 validation) for us.

    if (!webhooksOverride) {
        const port = Number(process.env.PORT ?? 3000);
        const middleware = createNodeMiddleware(webhooks, { path: '/github/webhook' });
        const http = createHttpServer(async (req, res) => {
            if (await middleware(req, res)) return;
            res.writeHead(404, { 'content-type': 'text/plain' });
            res.end('not found');
        });
        http.listen(port, () => {
            console.error(`[github-events] webhook listener on http://localhost:${port}/github/webhook`);
        });
        server.server.onclose = () => void http.close();
    }

    return server;
}

// --- main -------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('github MCP server running on stdio');
}
