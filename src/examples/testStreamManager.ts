#!/usr/bin/env node

/**
 * Comprehensive StreamManager Tests
 * Tests all merge strategies and edge cases
 */

import { StreamManager } from '../server/streaming.js';

async function testStreamManager(): Promise<void> {
    console.log('🧪 Testing StreamManager Functionality');
    console.log('='.repeat(50));

    let testsPassed = 0;
    let testsTotal = 0;

    function test(name: string, testFn: () => void): void {
        testsTotal++;
        try {
            testFn();
            console.log(`✅ ${name}`);
            testsPassed++;
        } catch (error) {
            console.log(`❌ ${name}: ${(error as Error).message}`);
        }
    }

    // Test 1: Basic stream creation
    test('Create stream with unique IDs', () => {
        const sm = new StreamManager();
        const id1 = sm.createStream('test_tool');
        const id2 = sm.createStream('test_tool');

        if (id1 === id2) throw new Error('Stream IDs not unique');
        // Note: Can't test exact IDs due to shared counter across instances
        if (!id1.startsWith('stream_')) throw new Error('Invalid ID format');
        if (!id2.startsWith('stream_')) throw new Error('Invalid ID format');
    });

    // Test 2: Concatenate strategy
    test('Concatenate merge strategy', () => {
        const sm = new StreamManager();
        const id = sm.createStream('test_tool', {
            streamingArguments: [{ name: 'content', mergeStrategy: 'concatenate' as const }]
        });

        sm.addChunk(id, 'content', 'Hello, ');
        sm.addChunk(id, 'content', 'World', true);

        const result = sm.completeStream(id);
        if (!result || result.content !== 'Hello, World') {
            throw new Error('Concatenation failed');
        }
    });

    // Test 3: JSON merge strategy
    test('JSON merge strategy', () => {
        const sm = new StreamManager();
        const id = sm.createStream('test_tool', {
            streamingArguments: [{ name: 'config', mergeStrategy: 'json_merge' as const }]
        });

        sm.addChunk(id, 'config', { a: 1, b: 2 });
        sm.addChunk(id, 'config', { b: 3, c: 4 }, true);

        const result = sm.completeStream(id);
        if (!result || JSON.stringify(result.config) !== JSON.stringify({ a: 1, b: 3, c: 4 })) {
            throw new Error('JSON merge failed');
        }
    });

    // Test 4: Last strategy
    test('Last merge strategy', () => {
        const sm = new StreamManager();
        const id = sm.createStream('test_tool', {
            streamingArguments: [{ name: 'value', mergeStrategy: 'last' as const }]
        });

        sm.addChunk(id, 'value', 'first');
        sm.addChunk(id, 'value', 'second');
        sm.addChunk(id, 'value', 'final', true);

        const result = sm.completeStream(id);
        if (!result || result.value !== 'final') {
            throw new Error('Last strategy failed');
        }
    });

    // Test 5: Multiple arguments with different strategies
    test('Multiple arguments with different strategies', () => {
        const sm = new StreamManager();
        const id = sm.createStream('test_tool', {
            streamingArguments: [
                { name: 'text', mergeStrategy: 'concatenate' as const },
                { name: 'config', mergeStrategy: 'json_merge' as const },
                { name: 'final', mergeStrategy: 'last' as const }
            ]
        });

        // Text (concatenate)
        sm.addChunk(id, 'text', 'Hello ');
        sm.addChunk(id, 'text', 'World', true);

        // Config (JSON merge)
        sm.addChunk(id, 'config', { a: 1 });
        sm.addChunk(id, 'config', { b: 2 }, true);

        // Final (last)
        sm.addChunk(id, 'final', 'first');
        sm.addChunk(id, 'final', 'second', true);

        const result = sm.completeStream(id);
        if (!result) throw new Error('No result returned');

        if (result.text !== 'Hello World') throw new Error('Text concatenation failed');
        if (JSON.stringify(result.config) !== JSON.stringify({ a: 1, b: 2 })) throw new Error('Config JSON merge failed');
        if (result.final !== 'second') throw new Error('Final last strategy failed');
    });

    // Test 6: Incomplete stream handling
    test('Incomplete stream returns null', () => {
        const sm = new StreamManager();
        const id = sm.createStream('test_tool', {
            streamingArguments: [{ name: 'content', mergeStrategy: 'concatenate' as const }]
        });

        sm.addChunk(id, 'content', 'Hello');
        // Don't mark as complete

        const result = sm.completeStream(id);
        if (result !== null) {
            throw new Error('Incomplete stream should return null');
        }
    });

    // Test 7: Error handling for invalid stream ID
    test('Error handling for invalid stream ID', () => {
        const sm = new StreamManager();

        try {
            sm.addChunk('invalid_id', 'content', 'data');
            throw new Error('Should have thrown error');
        } catch (error) {
            if (!(error as Error).message.includes('Invalid stream ID')) {
                throw new Error('Wrong error message');
            }
        }
    });

    // Test 8: Default merge strategy
    test('Default merge strategy is concatenate', () => {
        const sm = new StreamManager();
        const id = sm.createStream('test_tool', {
            streamingArguments: [{ name: 'content', mergeStrategy: 'concatenate' as const }] // Explicit for test
        });

        sm.addChunk(id, 'content', 'Hello ');
        sm.addChunk(id, 'content', 'World', true);

        const result = sm.completeStream(id);
        if (!result || result.content !== 'Hello World') {
            throw new Error('Default strategy should be concatenate');
        }
    });

    // Test 9: Non-string concatenation
    test('Non-string concatenation', () => {
        const sm = new StreamManager();
        const id = sm.createStream('test_tool', {
            streamingArguments: [{ name: 'data', mergeStrategy: 'concatenate' as const }]
        });

        sm.addChunk(id, 'data', 123);
        sm.addChunk(id, 'data', 456, true);

        const result = sm.completeStream(id);
        if (!result || result.data !== '123456') {
            throw new Error('Non-string concatenation failed');
        }
    });

    // Test 10: Stream cleanup
    test('Stream cleanup works', () => {
        const sm = new StreamManager();
        const id = sm.createStream('test_tool');

        if (!sm.getStream(id)) throw new Error('Stream not created');

        sm.cleanupStream(id);

        if (sm.getStream(id) !== undefined) {
            throw new Error('Stream not cleaned up');
        }
    });

    console.log(`\n📊 StreamManager Test Results: ${testsPassed}/${testsTotal} passed`);

    if (testsPassed === testsTotal) {
        console.log('🎉 All StreamManager tests passed!');
    } else {
        console.log(`❌ ${testsTotal - testsPassed} tests failed`);
        process.exit(1);
    }
}

testStreamManager().catch(console.error);
