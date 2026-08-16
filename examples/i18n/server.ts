/**
 * SEP-2792 per-request language negotiation with current request, cache, and
 * multi-round-trip APIs. One binary serves stdio or Streamable HTTP.
 */
import { serve } from '@hono/node-server';
import { parseExampleArgs } from '@mcp-examples/shared';
import { createMcpHonoApp } from '@modelcontextprotocol/hono';
import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import {
    acceptedContent,
    CONTENT_LANGUAGE_META,
    createMcpHandler,
    getAcceptLanguage,
    inputRequired,
    negotiateLanguage,
    Server
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const LANGUAGES = ['en', 'fr', 'de'] as const;
const DEFAULT_LANGUAGE = 'en';

const COPY = {
    en: {
        title: 'Deploy release',
        description: 'Deploys a release after localized operator approval',
        question: (environment: string) => `Deploy the release to ${environment}?`,
        approvalTitle: 'Approve deployment',
        progress: 'Preparing the deployment',
        success: (environment: string) => `Deployed successfully to ${environment}.`,
        declined: 'Deployment was not approved.'
    },
    fr: {
        title: 'Déployer la version',
        description: 'Déploie une version après approbation localisée de l’opérateur',
        question: (environment: string) => `Déployer la version vers ${environment} ?`,
        approvalTitle: 'Approuver le déploiement',
        progress: 'Préparation du déploiement',
        success: (environment: string) => `Déploiement réussi vers ${environment}.`,
        declined: 'Le déploiement n’a pas été approuvé.'
    },
    de: {
        title: 'Release bereitstellen',
        description: 'Stellt ein Release nach lokalisierter Freigabe bereit',
        question: (environment: string) => `Release in ${environment} bereitstellen?`,
        approvalTitle: 'Bereitstellung freigeben',
        progress: 'Bereitstellung wird vorbereitet',
        success: (environment: string) => `Erfolgreich in ${environment} bereitgestellt.`,
        declined: 'Die Bereitstellung wurde nicht freigegeben.'
    }
} as const;

type SupportedLanguage = keyof typeof COPY;

function selectedLanguage(ctx: ServerContext): SupportedLanguage {
    return negotiateLanguage(getAcceptLanguage({ _meta: ctx.mcpReq._meta }), LANGUAGES, DEFAULT_LANGUAGE) as SupportedLanguage;
}

function buildServer(): Server {
    const server = new Server(
        { name: 'i18n-deployment-example', version: '1.0.0' },
        {
            capabilities: { tools: {} },
            // Modern cache fields are stamped only on the 2026 wire. The client
            // additionally keys each entry by the exact acceptLanguage string.
            cacheHints: { 'tools/list': { ttlMs: 300_000, cacheScope: 'public' } }
        }
    );

    server.setRequestHandler('tools/list', (_request, ctx) => {
        const language = selectedLanguage(ctx);
        return {
            tools: [
                {
                    // Machine identifiers and schema property keys stay stable.
                    name: 'deploy_release',
                    title: COPY[language].title,
                    description: COPY[language].description,
                    inputSchema: {
                        type: 'object',
                        properties: {
                            environment: { type: 'string', description: 'Stable deployment target identifier' }
                        },
                        required: ['environment']
                    }
                }
            ],
            _meta: { [CONTENT_LANGUAGE_META]: language }
        };
    });

    server.setRequestHandler('tools/call', async (request, ctx): Promise<CallToolResult | InputRequiredResult> => {
        const environment =
            typeof request.params.arguments?.['environment'] === 'string' ? request.params.arguments.environment : 'production';
        const language = selectedLanguage(ctx);
        const copy = COPY[language];
        const approval = acceptedContent<{ approve: boolean }>(ctx.mcpReq.inputResponses, 'approval');

        if (approval === undefined) {
            const progressToken = ctx.mcpReq._meta?.progressToken;
            if (typeof progressToken === 'string' || typeof progressToken === 'number') {
                await ctx.mcpReq.notify({
                    method: 'notifications/progress',
                    params: {
                        progressToken,
                        progress: 0.5,
                        total: 1,
                        message: copy.progress,
                        _meta: { [CONTENT_LANGUAGE_META]: language }
                    }
                });
            }

            return {
                ...inputRequired({
                    inputRequests: {
                        approval: inputRequired.elicit({
                            message: copy.question(environment),
                            requestedSchema: {
                                type: 'object',
                                properties: {
                                    // The key remains "approve"; only display text changes.
                                    approve: { type: 'boolean', title: copy.approvalTitle }
                                },
                                required: ['approve']
                            }
                        })
                    }
                }),
                _meta: { [CONTENT_LANGUAGE_META]: language }
            };
        }

        if (!approval.approve) {
            return {
                isError: true,
                content: [{ type: 'text', text: copy.declined }],
                _meta: { [CONTENT_LANGUAGE_META]: language }
            };
        }
        return {
            content: [{ type: 'text', text: copy.success(environment) }],
            _meta: { [CONTENT_LANGUAGE_META]: language }
        };
    });

    return server;
}

const { transport, port } = parseExampleArgs();

if (transport === 'stdio') {
    void serveStdio(buildServer);
    console.error('[i18n-server] serving over stdio');
} else {
    const handler = createMcpHandler(buildServer);
    const app = createMcpHonoApp();
    app.all('/mcp', c => handler.fetch(c.req.raw));
    serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
        console.error(`[i18n-server] listening on http://127.0.0.1:${port}/mcp`);
    });
}
