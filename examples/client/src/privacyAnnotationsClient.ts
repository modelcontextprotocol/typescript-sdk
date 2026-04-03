/**
 * Privacy Annotations Example Client
 *
 * Demonstrates SEP-0000: Privacy Annotations for Tool Metadata.
 *
 * This client:
 * 1. Connects to the privacy annotations example server
 * 2. Lists tools and inspects their privacyHint annotations
 * 3. Calls tools with RequestPrivacy metadata (purpose, justifications, location)
 * 4. Reads ResponsePrivacy from each tool call result
 * 5. Demonstrates a cross-border scenario (client in DE, server in US)
 *
 * Run the server first:
 *   npx tsx ../server/src/privacyAnnotationsExample.ts
 *
 * Then run this client:
 *   npx tsx src/privacyAnnotationsClient.ts
 */

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const SERVER_URL = process.env.MCP_SERVER_URL || 'http://localhost:3000/mcp';

async function main(): Promise<void> {
    console.log('Privacy Annotations Example Client');
    console.log('==================================\n');

    // Connect to server
    const client = new Client({ name: 'privacy-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));
    await client.connect(transport);
    console.log('Connected to server.\n');

    // --- Step 1: List tools and inspect privacy hints ---

    console.log('=== Tool Privacy Hints ===\n');
    const { tools } = await client.listTools();

    for (const tool of tools) {
        const hint = tool.annotations?.privacyHint;
        console.log(`Tool: ${tool.name}`);
        if (hint) {
            console.log(`  Data categories: ${hint.dataCategories?.join(', ') ?? 'none'}`);
            console.log(`  Countries:       ${hint.countries?.join(', ') ?? 'unspecified'}`);
            console.log(`  Subdivisions:    ${hint.subdivisions?.join(', ') ?? 'unspecified'}`);
        } else {
            console.log('  No privacy hint declared');
        }
        console.log('');
    }

    // --- Step 2: Call get_patient_record with treatment purpose (US client) ---

    console.log('=== Scenario 1: US client requesting patient record for treatment ===\n');

    const patientResult = await client.callTool({
        name: 'get_patient_record',
        arguments: { patient_id: 'P-12345' },
        _meta: {
            privacy: {
                purpose: 'treatment',
                justifications: ['contract'],
                minor: false,
                country: 'US',
                subdivision: 'US-CA'
            }
        }
    });

    console.log('Response content:', patientResult.content[0]?.type === 'text' ? patientResult.content[0].text : '(non-text)');
    console.log('Response privacy:', JSON.stringify(patientResult._meta?.privacy, null, 2));
    console.log('');

    // --- Step 3: Call process_payment with payment purpose ---

    console.log('=== Scenario 2: Processing a payment ===\n');

    const paymentResult = await client.callTool({
        name: 'process_payment',
        arguments: { amount: 150, card_token: 'tok_abc123xyz789' },
        _meta: {
            privacy: {
                purpose: 'payment_processing',
                justifications: ['contract'],
                country: 'US',
                subdivision: 'US-CA'
            }
        }
    });

    console.log('Response content:', paymentResult.content[0]?.type === 'text' ? paymentResult.content[0].text : '(non-text)');
    console.log('Response privacy:', JSON.stringify(paymentResult._meta?.privacy, null, 2));
    console.log('');

    // --- Step 4: Cross-border scenario — DE client calling global_search ---

    console.log('=== Scenario 3: Cross-border — German client calling global search ===\n');

    const searchResult = await client.callTool({
        name: 'global_search',
        arguments: { query: 'customer 42' },
        _meta: {
            privacy: {
                purpose: 'support',
                justifications: ['contract'],
                country: 'DE',
                subdivision: 'DE-BY'
            }
        }
    });

    console.log('Response content:', searchResult.content[0]?.type === 'text' ? searchResult.content[0].text : '(non-text)');
    const searchPrivacy = searchResult._meta?.privacy;
    console.log('Response privacy:', JSON.stringify(searchPrivacy, null, 2));

    if (searchPrivacy) {
        console.log('');
        console.log('Cross-border analysis:');
        console.log(`  Client location:  DE (Bavaria)`);
        console.log(`  Server processed: ${searchPrivacy.countries?.join(', ')} (${searchPrivacy.subdivisions?.join(', ')})`);
        console.log(`  Data categories:  ${searchPrivacy.dataCategories?.join(', ')}`);
        console.log('  → A policy engine would evaluate EU→US transfer restrictions');
    }

    console.log('\n=== Done ===');
    await client.close();
}

await main();
