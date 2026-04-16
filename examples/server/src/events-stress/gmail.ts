/**
 * Gmail — MCP Events server (production-ready).
 *
 * Exposes `gmail.message_received`, which fires whenever a new message lands in
 * the authenticated user's mailbox. The event carries a thin `{messageId, threadId,
 * labelIds}` payload; clients fetch the full body via the companion
 * `gmail_get_message` tool. The check callback is backed by Gmail's
 * `users.history.list` API using `historyId` as the durable cursor — the SDK never
 * invents a cursor, it passes Gmail's straight through. A 404 from Gmail (stale
 * historyId, typically >1 week old) is mapped to `CURSOR_EXPIRED` so the client
 * re-bootstraps automatically.
 *
 * ## Setup
 *
 * 1. Create a Google Cloud project at https://console.cloud.google.com
 * 2. Enable the Gmail API for the project
 *    (APIs & Services → Library → Gmail API → Enable)
 * 3. Create OAuth 2.0 credentials (APIs & Services → Credentials → Create
 *    Credentials → OAuth client ID → Application type: Desktop app)
 * 4. Run the OAuth consent flow once to obtain a refresh token:
 *      npx google-auth-library --scopes https://www.googleapis.com/auth/gmail.readonly
 *    Copy the printed refresh_token.
 * 5. Export the three environment variables below and run the server.
 *
 * ## Environment variables
 *
 * | Variable              | Description                                      |
 * |-----------------------|--------------------------------------------------|
 * | GOOGLE_CLIENT_ID      | OAuth 2.0 client ID from step 3                  |
 * | GOOGLE_CLIENT_SECRET  | OAuth 2.0 client secret from step 3              |
 * | GOOGLE_REFRESH_TOKEN  | Refresh token obtained in step 4                 |
 *
 * ## Run
 *
 *   pnpm --filter @modelcontextprotocol/examples-server exec tsx src/events-stress/gmail.ts
 */

import { CURSOR_EXPIRED, McpServer, ProtocolError, StdioServerTransport } from '@modelcontextprotocol/server';
import type { gmail_v1 } from 'googleapis';
import { google } from 'googleapis';
import * as z from 'zod/v4';

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

/** Build an authenticated Gmail client from the three GOOGLE_* env vars. */
function defaultGmailClient(): gmail_v1.Gmail {
    const oauth2 = new google.auth.OAuth2(requireEnv('GOOGLE_CLIENT_ID'), requireEnv('GOOGLE_CLIENT_SECRET'));
    oauth2.setCredentials({ refresh_token: requireEnv('GOOGLE_REFRESH_TOKEN') });
    return google.gmail({ version: 'v1', auth: oauth2 });
}

/**
 * Cursor encoding. Gmail paginates within a single historyId via nextPageToken,
 * so we pack both into one opaque string: "<historyId>" or "<historyId>:<pageToken>".
 */
function encodeCursor(historyId: string, pageToken?: string | null): string {
    return pageToken ? `${historyId}:${pageToken}` : historyId;
}
function decodeCursor(cursor: string): { historyId: string; pageToken?: string } {
    const sep = cursor.indexOf(':');
    if (sep === -1) return { historyId: cursor };
    return { historyId: cursor.slice(0, sep), pageToken: cursor.slice(sep + 1) };
}

// --- Server ----------------------------------------------------------------

export function createServer(gmail: gmail_v1.Gmail = defaultGmailClient()): McpServer {
    const server = new McpServer(
        { name: 'gmail-events', version: '1.0.0' },
        {
            events: {
                push: { heartbeatIntervalMs: 15_000 },
                webhook: { ttlMs: 5 * 60 * 1000, urlValidation: { allowInsecure: true, allowPrivateNetworks: true } }
            }
        }
    );

    const subscribeParams = z.object({
        /** Optional Gmail label to narrow the history query (e.g. "INBOX", "IMPORTANT"). */
        labelId: z.string().default('INBOX')
    });

    server.registerEvent(
        'gmail.message_received',
        {
            description: 'Fires when a new message lands in the authenticated Gmail mailbox (filtered by label).',
            inputSchema: subscribeParams,
            payloadSchema: z.object({
                messageId: z.string(),
                threadId: z.string(),
                labelIds: z.array(z.string())
            })
        },
        async ({ labelId }, cursor) => {
            // --- Bootstrap branch -------------------------------------------------
            if (cursor === null) {
                // history.list requires a starting historyId; seed it from the
                // profile endpoint and return zero events.
                const { data: profile } = await gmail.users.getProfile({ userId: 'me' });
                const historyId = profile.historyId;
                if (!historyId) throw new Error('Gmail getProfile returned no historyId');
                return { events: [], cursor: encodeCursor(historyId), nextPollSeconds: 20 };
            }

            // --- Resume branch ----------------------------------------------------
            const { historyId: startHistoryId, pageToken } = decodeCursor(cursor);

            let page: gmail_v1.Schema$ListHistoryResponse;
            try {
                const res = await gmail.users.history.list({
                    userId: 'me',
                    startHistoryId,
                    historyTypes: ['messageAdded'],
                    labelId,
                    pageToken,
                    maxResults: 100
                });
                page = res.data;
            } catch (error) {
                // Gmail returns HTTP 404 when startHistoryId has aged out of the
                // retention window (~1 week). Map to CURSOR_EXPIRED → client re-bootstraps.
                const code =
                    (error as { code?: number; response?: { status?: number } }).code ??
                    (error as { response?: { status?: number } }).response?.status;
                if (code === 404) {
                    throw new ProtocolError(CURSOR_EXPIRED, 'Gmail historyId expired; re-sync required');
                }
                throw error;
            }

            const events = (page.history ?? [])
                .flatMap(h => h.messagesAdded ?? [])
                .filter(a => a.message?.id && a.message.threadId)
                .map(a => ({
                    name: 'gmail.message_received',
                    data: {
                        messageId: a.message!.id!,
                        threadId: a.message!.threadId!,
                        labelIds: a.message!.labelIds ?? []
                    }
                }));

            // If Gmail gave us a nextPageToken there are more records at the same
            // startHistoryId — keep it and let hasMore drive an immediate re-poll.
            // Otherwise advance to the response's historyId (or hold position if absent).
            const nextCursor = page.nextPageToken
                ? encodeCursor(startHistoryId, page.nextPageToken)
                : encodeCursor(page.historyId ?? startHistoryId);

            return {
                events,
                cursor: nextCursor,
                hasMore: Boolean(page.nextPageToken),
                // Back off when quiet, tighten when busy.
                nextPollSeconds: events.length > 0 ? 10 : 45
            };
        }
    );

    // Companion tool: fetch the full message referenced by a thin event payload.
    server.registerTool(
        'gmail_get_message',
        {
            description: 'Fetch the full Gmail message referenced by a gmail.message_received event.',
            inputSchema: z.object({
                messageId: z.string(),
                format: z.enum(['minimal', 'full', 'metadata']).default('full')
            })
        },
        async ({ messageId, format }) => {
            const { data } = await gmail.users.messages.get({ userId: 'me', id: messageId, format });
            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }
    );

    return server;
}

// --- main ------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('gmail MCP server running on stdio');
}
