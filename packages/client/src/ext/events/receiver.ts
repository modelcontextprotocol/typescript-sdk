import type { EventOccurrence } from '@modelcontextprotocol/core/ext/events';
import {
    EventOccurrenceSchema,
    WEBHOOK_SUBSCRIPTION_ID_HEADER,
    WebhookControlBodySchema,
    WebhookVerificationBodySchema
} from '@modelcontextprotocol/core/ext/events';
import { ProtocolError } from '@modelcontextprotocol/core-internal';
import { EventsError, parseWebhookSecret, verifyWebhookSignature } from '@modelcontextprotocol/core-internal/ext/events';

// Where the receiver routes one subscription's deliveries.
export interface WebhookSink {
    event(occurrence: EventOccurrence): void;
    gap(cursor: string | null): void;
    // An Events kind arrives as `EventsError`.
    terminated(error: ProtocolError): void;
}

const MAX_BODY_BYTES = 262_144;
const TIMESTAMP_TOLERANCE_SECONDS = 300;
const DEDUPE_WINDOW = 1000;

// Keeps every byte (a BOM too) and refuses invalid UTF-8, so the text signs as the raw body does.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function keyOf(secret: string): Uint8Array {
    const key = parseWebhookSecret(secret);
    if (key === undefined) throw new TypeError('Not a Standard Webhooks secret (whsec_ and base64 of 24 to 64 bytes)');
    return key;
}

function status(code: number, headers?: Record<string, string>): Response {
    return new Response(null, { status: code, headers });
}

// The body as text; `undefined` once it is over the size cap. Throws on bytes that are not UTF-8.
async function readBody(request: Request): Promise<string | undefined> {
    if (request.body === null) return '';
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        size += chunk.value.byteLength;
        if (size > MAX_BODY_BYTES) {
            await reader.cancel();
            return undefined;
        }
        chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return decoder.decode(bytes);
}

// The JSON object `text` holds; `undefined` for anything else.
function jsonObject(text: string): object | undefined {
    try {
        const value: unknown = JSON.parse(text);
        return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
    } catch {
        return undefined;
    }
}

// One client's webhook endpoint (spec §6.4): verifies Standard Webhooks signatures, answers the verification challenge, and routes deliveries by `X-MCP-Subscription-Id`.
export class WebhookReceiver {
    // Secrets of subscriptions whose id is not known yet.
    readonly #pending = new Set<{ key: Uint8Array; onBind(id: string): void }>();
    // By subscription id: its secret, and where its deliveries go once bound.
    readonly #bound = new Map<string, { key: Uint8Array; sink?: WebhookSink }>();
    // The last 1 000 `webhook-id`s delivered, oldest first.
    readonly #seen = new Set<string>();

    // Answers a verification signed with `secret` for an id not bound yet, then calls `onBind` with that id; the returned function withdraws the secret.
    registerPending(secret: string, onBind: (id: string) => void): () => void {
        const entry = { key: keyOf(secret), onBind };
        this.#pending.add(entry);
        return () => void this.#pending.delete(entry);
    }

    // Routes deliveries for `id`, signed with `secret`, to `sink`.
    bind(id: string, secret: string, sink: WebhookSink): void {
        this.#bound.set(id, { key: keyOf(secret), sink });
    }

    // Stops routing `id` to `sink`, answering its deliveries 503 from now on; a binding another sink has taken over stays.
    forget(id: string, sink: WebhookSink): void {
        if (this.#bound.get(id)?.sink === sink) this.#bound.delete(id);
    }

    async handle(request: Request): Promise<Response> {
        if (request.method !== 'POST') return status(405, { Allow: 'POST' });
        const webhookId = request.headers.get('webhook-id');
        const timestamp = request.headers.get('webhook-timestamp');
        const signature = request.headers.get('webhook-signature');
        const id = request.headers.get(WEBHOOK_SUBSCRIPTION_ID_HEADER);
        if (webhookId === null || timestamp === null || signature === null || id === null) return status(400);
        const seconds = /^\d+$/.test(timestamp) ? Number(timestamp) : Number.NaN;
        // Written so a timestamp that is not a number fails too.
        if (!(Math.abs(Math.floor(Date.now() / 1000) - seconds) <= TIMESTAMP_TOLERANCE_SECONDS)) return status(400);
        const raw = await readBody(request).catch(() => null);
        if (raw === undefined) return status(413);
        const body = raw === null ? undefined : jsonObject(raw);
        if (raw === null || body === undefined) return status(400);
        const verifies = (key: Uint8Array): Promise<boolean> => verifyWebhookSignature([key], webhookId, seconds, raw, signature);
        if ('type' in body && body.type === 'verification') return this.#verification(id, body, verifies);

        const target = this.#bound.get(id);
        if (target?.sink === undefined) return status(503);
        if (!(await verifies(target.key))) return status(401);
        if (this.#seen.has(webhookId)) return status(200);
        const route = this.#route(body, target.sink);
        if (route === undefined) return status(400);
        this.#remember(webhookId);
        route();
        return status(200);
    }

    // Tries the id's own secret (a server that lost its verification asks again), then every pending one.
    async #verification(id: string, body: object, verifies: (key: Uint8Array) => Promise<boolean>): Promise<Response> {
        const parsed = WebhookVerificationBodySchema.safeParse(body);
        if (!parsed.success) return status(400);
        const answer = Response.json({ challenge: parsed.data.challenge });
        const bound = this.#bound.get(id);
        if (bound !== undefined && (await verifies(bound.key))) return answer;
        for (const entry of this.#pending) {
            // Withdrawn while the signature was checked.
            if (!(await verifies(entry.key)) || !this.#pending.delete(entry)) continue;
            this.#bound.set(id, { ...this.#bound.get(id), key: entry.key });
            entry.onBind(id);
            return answer;
        }
        return status(401);
    }

    // Delivers a valid event, `gap` or `terminated` body to `sink`; `undefined` for any other body.
    #route(body: object, sink: WebhookSink): (() => void) | undefined {
        if (!('type' in body)) {
            const occurrence = EventOccurrenceSchema.safeParse(body);
            return occurrence.success ? () => sink.event(occurrence.data) : undefined;
        }
        const control = WebhookControlBodySchema.safeParse(body);
        if (!control.success) return undefined;
        const message = control.data;
        if (message.type === 'gap') return () => sink.gap(message.cursor ?? null);
        if (message.type !== 'terminated') return undefined;
        const { code, message: text, data } = message.error;
        const error = ProtocolError.fromError(code, text, data);
        return () => sink.terminated(EventsError.fromProtocolError(error) ?? error);
    }

    #remember(webhookId: string): void {
        this.#seen.add(webhookId);
        if (this.#seen.size > DEDUPE_WINDOW) this.#seen.delete(this.#seen.values().next().value!);
    }
}
