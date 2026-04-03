/**
 * Privacy Annotations Example Server
 *
 * Demonstrates SEP-0000: Privacy Annotations for Tool Metadata.
 *
 * This server declares three tools with different privacy profiles:
 * - get_patient_record: health + genetic data in US-CA
 * - process_payment: financial + authentication data in US-CA + US-VA
 * - global_search: personal data with global processing
 *
 * Each tool handler:
 * 1. Reads the client's RequestPrivacy from _meta.privacy
 * 2. Logs a privacy audit trail
 * 3. Returns ResponsePrivacy declaring what data was actually accessed
 *
 * Run with: npx tsx src/privacyAnnotationsExample.ts
 * Then connect with the privacy annotations client example.
 */

import { randomUUID } from 'node:crypto';

import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { getRequestPrivacy, isInitializeRequest, McpServer } from '@modelcontextprotocol/server';
import express from 'express';
import * as z from 'zod/v4';

// Create server
const server = new McpServer({
    name: 'privacy-annotations-example',
    version: '1.0.0'
});

// --- Tool 1: Patient records (health + genetic data, US-CA) ---

server.registerTool(
    'get_patient_record',
    {
        title: 'Get Patient Record',
        description: 'Retrieve a patient medical record by ID',
        inputSchema: z.object({
            patient_id: z.string().describe('The patient identifier')
        }),
        annotations: {
            title: 'Get Patient Record',
            readOnlyHint: true,
            openWorldHint: false,
            privacyHint: {
                dataCategories: ['personal', 'health', 'genetic'],
                countries: ['US'],
                subdivisions: ['US-CA']
            }
        }
    },
    async ({ patient_id }, ctx): Promise<CallToolResult> => {
        // Read the client's privacy context
        const requestPrivacy = getRequestPrivacy(ctx);

        console.log('[AUDIT] get_patient_record called', {
            patientId: patient_id,
            purpose: requestPrivacy?.purpose,
            justifications: requestPrivacy?.justifications,
            clientCountry: requestPrivacy?.country,
            clientSubdivision: requestPrivacy?.subdivision,
            minor: requestPrivacy?.minor
        });

        // Simulated patient record
        const record = {
            id: patient_id,
            name: 'Jane Doe',
            dob: '1985-03-15',
            diagnoses: ['Type 2 Diabetes'],
            geneticMarkers: ['BRCA1-negative']
        };

        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify(record, null, 2)
                }
            ],
            _meta: {
                privacy: {
                    dataCategories: ['personal', 'health', 'genetic'],
                    countries: ['US'],
                    subdivisions: ['US-CA'],
                    minor: requestPrivacy?.minor ?? false
                }
            }
        };
    }
);

// --- Tool 2: Payment processing (financial data, multi-state) ---

server.registerTool(
    'process_payment',
    {
        title: 'Process Payment',
        description: 'Process a credit card payment',
        inputSchema: z.object({
            amount: z.number().describe('Payment amount in USD'),
            card_token: z.string().describe('Tokenized card reference')
        }),
        annotations: {
            title: 'Process Payment',
            readOnlyHint: false,
            destructiveHint: true,
            privacyHint: {
                dataCategories: ['personal', 'financial', 'authentication'],
                countries: ['US'],
                subdivisions: ['US-CA', 'US-VA']
            }
        }
    },
    async ({ amount, card_token }, ctx): Promise<CallToolResult> => {
        const requestPrivacy = getRequestPrivacy(ctx);

        console.log('[AUDIT] process_payment called', {
            amount,
            purpose: requestPrivacy?.purpose,
            justifications: requestPrivacy?.justifications,
            clientCountry: requestPrivacy?.country
        });

        return {
            content: [
                {
                    type: 'text',
                    text: `Payment of $${amount} processed with token ${card_token.slice(0, 8)}...`
                }
            ],
            _meta: {
                privacy: {
                    dataCategories: ['personal', 'financial'],
                    countries: ['US'],
                    subdivisions: ['US-CA']
                }
            }
        };
    }
);

// --- Tool 3: Global search (personal data, globally distributed) ---

server.registerTool(
    'global_search',
    {
        title: 'Global Search',
        description: 'Search across distributed data stores',
        inputSchema: z.object({
            query: z.string().describe('Search query')
        }),
        annotations: {
            title: 'Global Search',
            readOnlyHint: true,
            privacyHint: {
                dataCategories: ['personal'],
                countries: ['global']
            }
        }
    },
    async ({ query }, ctx): Promise<CallToolResult> => {
        const requestPrivacy = getRequestPrivacy(ctx);

        console.log('[AUDIT] global_search called', {
            query,
            purpose: requestPrivacy?.purpose,
            justifications: requestPrivacy?.justifications,
            clientCountry: requestPrivacy?.country,
            clientSubdivision: requestPrivacy?.subdivision
        });

        // Simulate routing to a specific region
        const processingRegion = { country: 'US', subdivision: 'US-VA' };

        return {
            content: [
                {
                    type: 'text',
                    text: `Search results for "${query}" (processed in ${processingRegion.country}-${processingRegion.subdivision})`
                }
            ],
            _meta: {
                privacy: {
                    dataCategories: ['personal', 'financial'],
                    countries: [processingRegion.country],
                    subdivisions: [processingRegion.subdivision]
                }
            }
        };
    }
);

// --- HTTP Transport Setup ---

const PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;

const app = express();
app.use(express.json());

const transports: Record<string, NodeStreamableHTTPServerTransport> = {};

app.all('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    try {
        let transport: NodeStreamableHTTPServerTransport;
        if (sessionId && transports[sessionId]) {
            transport = transports[sessionId];
        } else if (!sessionId && isInitializeRequest(req.body)) {
            transport = new NodeStreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: id => {
                    transports[id] = transport;
                }
            });

            transport.onclose = () => {
                if (transport.sessionId) {
                    delete transports[transport.sessionId];
                }
            };

            await server.server.connect(transport);
        } else {
            res.status(400).json({ error: 'Bad request: no valid session' });
            return;
        }

        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error('Error handling MCP request:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Internal server error' });
        }
    }
});

app.listen(PORT, () => {
    console.log(`Privacy Annotations Example Server running on http://localhost:${PORT}/mcp`);
    console.log('');
    console.log('Tools registered:');
    console.log('  - get_patient_record  [health, genetic]  US-CA');
    console.log('  - process_payment     [financial, auth]   US-CA, US-VA');
    console.log('  - global_search       [personal]          global');
    console.log('');
    console.log('Connect with: npx tsx ../client/src/privacyAnnotationsClient.ts');
});
