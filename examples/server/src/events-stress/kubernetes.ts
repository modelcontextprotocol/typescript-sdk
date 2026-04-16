/**
 * Kubernetes — MCP Events server (production-ready).
 *
 * Exposes pod phase transitions (`k8s.pod_phase_changed`) and cluster events
 * (`k8s.event`) from a live Kubernetes cluster via the MCP Events primitive.
 * Uses the canonical list-then-watch pattern: bootstrap LIST snapshots a
 * `resourceVersion`, subsequent polls open a short-lived WATCH from that RV,
 * drain a bounded batch, and advance the cursor. A 410 Gone from the apiserver
 * (RV compacted) surfaces as `CURSOR_EXPIRED` so the client re-bootstraps.
 *
 * ## Setup
 *
 * 1. Have a cluster reachable from this process. For local dev:
 *      kind create cluster        # or: minikube start
 * 2. Verify kubectl works:
 *      kubectl get pods -A
 * 3. (Optional) Point KUBECONFIG at a non-default kubeconfig file.
 *
 * ## Environment variables
 *
 * | Variable      | Required | Description                                        |
 * |---------------|----------|----------------------------------------------------|
 * | KUBECONFIG    | no       | Path to kubeconfig (default: ~/.kube/config)       |
 * | K8S_NAMESPACE | no       | Default namespace if subscriber omits it (default) |
 *
 * ## Run
 *
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/events-stress/kubernetes.ts
 */

import type { CoreV1Event, V1Pod } from '@kubernetes/client-node';
import { CoreV1Api, KubeConfig, Watch } from '@kubernetes/client-node';
import { CURSOR_EXPIRED, McpServer, ProtocolError, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

// --- k8s client wiring -------------------------------------------------------

export interface K8sDeps {
    core: CoreV1Api;
    watch: Watch;
}

function createK8sDeps(): K8sDeps {
    const kc = new KubeConfig();
    const kubeconfigPath = process.env.KUBECONFIG;
    if (kubeconfigPath) {
        kc.loadFromFile(kubeconfigPath);
    } else {
        kc.loadFromDefault();
    }
    if (!kc.getCurrentCluster()) {
        throw new Error('No Kubernetes cluster found in kubeconfig. Run `kind create cluster` or set KUBECONFIG.');
    }
    return { core: kc.makeApiClient(CoreV1Api), watch: new Watch(kc) };
}

// --- opaque cursor encoding --------------------------------------------------

interface Cursor {
    pods: string;
    events: string;
}
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString('base64url');
const decodeCursor = (s: string): Cursor => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// --- bounded watch drain -----------------------------------------------------

const DRAIN_BATCH = 25; // max events returned per check()
const DRAIN_WINDOW_MS = 4000; // how long to hold the watch open per poll

interface WatchFrame<T> {
    phase: 'ADDED' | 'MODIFIED' | 'DELETED' | 'BOOKMARK';
    obj: T;
}

/**
 * Opens a watch at `resourceVersion`, collects up to DRAIN_BATCH non-bookmark
 * frames or DRAIN_WINDOW_MS elapses, then aborts. Throws ProtocolError on 410.
 */
async function drainWatch<T extends { metadata?: { resourceVersion?: string } }>(
    watch: Watch,
    path: string,
    resourceVersion: string,
    labelSelector: string | undefined
): Promise<{ frames: WatchFrame<T>[]; newRV: string; hasMore: boolean }> {
    const frames: WatchFrame<T>[] = [];
    let newRV = resourceVersion;
    let gone = false;
    let doneErr: unknown = null;

    const controller = await watch.watch(
        path,
        { resourceVersion, allowWatchBookmarks: true, labelSelector },
        (phase, apiObj, watchObj) => {
            if (phase === 'ERROR') {
                // apiserver sent a Status object; check for 410 Gone
                const status = (watchObj ?? apiObj) as { code?: number; status?: { code?: number } };
                const code = status?.code ?? status?.status?.code;
                if (code === 410) gone = true;
                return;
            }
            const obj = apiObj as T;
            const rv = obj?.metadata?.resourceVersion;
            if (rv) newRV = rv;
            if (phase === 'BOOKMARK') return; // RV advanced, no user-visible event
            if (phase === 'ADDED' || phase === 'MODIFIED' || phase === 'DELETED') {
                frames.push({ phase, obj });
            }
        },
        err => {
            doneErr = err;
        }
    );

    // Hold the watch open for a bounded window, or until we fill the batch.
    const deadline = Date.now() + DRAIN_WINDOW_MS;
    while (Date.now() < deadline && frames.length < DRAIN_BATCH && !gone && doneErr === null) {
        await new Promise(r => setTimeout(r, 100));
    }
    controller.abort();

    if (gone) {
        throw new ProtocolError(CURSOR_EXPIRED, 'resourceVersion too old (410 Gone); relist required');
    }
    // Surface transport errors that aren't self-abort or server-side close.
    if (doneErr && doneErr !== Watch.SERVER_SIDE_CLOSE && (doneErr as Error)?.name !== 'AbortError') {
        const code = (doneErr as { statusCode?: number; code?: number }).statusCode ?? (doneErr as { code?: number }).code;
        if (code === 410) {
            throw new ProtocolError(CURSOR_EXPIRED, 'resourceVersion too old (410 Gone); relist required');
        }
        throw doneErr;
    }

    return { frames, newRV, hasMore: frames.length >= DRAIN_BATCH };
}

// --- server ------------------------------------------------------------------

const DEFAULT_NS = process.env.K8S_NAMESPACE ?? 'default';

export function createServer(deps?: K8sDeps): McpServer {
    const k8s = deps ?? createK8sDeps();
    const server = new McpServer({ name: 'k8s-events', version: '1.0.0' }, { events: { push: { heartbeatIntervalMs: 10_000 } } });

    const inputSchema = z.object({
        namespace: z.string().default(DEFAULT_NS),
        labelSelector: z.string().optional().describe('k8s label selector, e.g. "app=demo,tier=web"')
    });

    const podPayload = z.object({
        name: z.string(),
        namespace: z.string(),
        phase: z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']),
        resourceVersion: z.string()
    });
    const eventPayload = z.object({
        name: z.string(),
        namespace: z.string(),
        reason: z.string(),
        message: z.string(),
        involvedObjectKind: z.string(),
        resourceVersion: z.string()
    });

    type Params = z.infer<typeof inputSchema>;

    // Bootstrap = LIST both GVKs, snapshot resourceVersion. Shared so neither
    // lane falls behind the compaction horizon.
    async function bootstrap({ namespace, labelSelector }: Params): Promise<string> {
        const [pods, events] = await Promise.all([
            k8s.core.listNamespacedPod({ namespace, labelSelector }),
            k8s.core.listNamespacedEvent({ namespace })
        ]);
        return encodeCursor({
            pods: pods.metadata?.resourceVersion ?? '0',
            events: events.metadata?.resourceVersion ?? '0'
        });
    }

    server.registerEvent(
        'k8s.pod_phase_changed',
        {
            description: 'Pod .status.phase transitioned (via watch MODIFIED)',
            inputSchema,
            payloadSchema: podPayload
        },
        async (params, cursor) => {
            if (cursor === null) {
                return { events: [], cursor: await bootstrap(params), nextPollSeconds: 5 };
            }
            const cur = decodeCursor(cursor);
            const { frames, newRV, hasMore } = await drainWatch<V1Pod>(
                k8s.watch,
                `/api/v1/namespaces/${params.namespace}/pods`,
                cur.pods,
                params.labelSelector
            );
            const events = frames
                .filter(f => f.phase === 'ADDED' || f.phase === 'MODIFIED')
                .map(f => ({
                    name: 'k8s.pod_phase_changed',
                    data: {
                        name: f.obj.metadata?.name ?? '',
                        namespace: f.obj.metadata?.namespace ?? params.namespace,
                        phase: (f.obj.status?.phase ?? 'Unknown') as z.infer<typeof podPayload>['phase'],
                        resourceVersion: f.obj.metadata?.resourceVersion ?? ''
                    }
                }));
            return {
                events,
                cursor: encodeCursor({ ...cur, pods: newRV }),
                hasMore,
                nextPollSeconds: 5
            };
        }
    );

    server.registerEvent(
        'k8s.event',
        {
            description: 'core/v1 Event object created in namespace',
            inputSchema,
            payloadSchema: eventPayload
        },
        async (params, cursor) => {
            if (cursor === null) {
                return { events: [], cursor: await bootstrap(params), nextPollSeconds: 5 };
            }
            const cur = decodeCursor(cursor);
            const { frames, newRV, hasMore } = await drainWatch<CoreV1Event>(
                k8s.watch,
                `/api/v1/namespaces/${params.namespace}/events`,
                cur.events,
                params.labelSelector
            );
            const events = frames.map(f => ({
                name: 'k8s.event',
                data: {
                    name: f.obj.metadata?.name ?? '',
                    namespace: f.obj.metadata?.namespace ?? params.namespace,
                    reason: f.obj.reason ?? '',
                    message: f.obj.message ?? '',
                    involvedObjectKind: f.obj.involvedObject?.kind ?? '',
                    resourceVersion: f.obj.metadata?.resourceVersion ?? ''
                }
            }));
            return {
                events,
                cursor: encodeCursor({ ...cur, events: newRV }),
                hasMore,
                nextPollSeconds: 5
            };
        }
    );

    return server;
}

// --- main --------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('kubernetes MCP server running on stdio');
}
