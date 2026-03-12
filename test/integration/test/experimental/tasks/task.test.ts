import { isTerminal } from '@modelcontextprotocol/core';
import type { Task } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

describe('Task utility functions', () => {
    describe('isTerminal', () => {
        it('should return true for completed status', () => {
            expect(isTerminal('completed')).toBe(true);
        });

        it('should return true for failed status', () => {
            expect(isTerminal('failed')).toBe(true);
        });

        it('should return true for cancelled status', () => {
            expect(isTerminal('cancelled')).toBe(true);
        });

        it('should return false for working status', () => {
            expect(isTerminal('working')).toBe(false);
        });

        it('should return false for input_required status', () => {
            expect(isTerminal('input_required')).toBe(false);
        });
    });
});

describe('Task Schema Validation', () => {
    it('should validate task with ttl field', () => {
        const createdAt = new Date().toISOString();
        const task: Task = {
            taskId: 'test-123',
            status: 'working',
            ttl: 60_000,
            createdAt,
            lastUpdatedAt: createdAt,
            pollInterval: 1000
        };

        expect(task.ttl).toBe(60_000);
        expect(task.createdAt).toBeDefined();
        expect(typeof task.createdAt).toBe('string');
    });

    it('should validate task with null ttl', () => {
        const createdAt = new Date().toISOString();
        const task: Task = {
            taskId: 'test-456',
            status: 'completed',
            ttl: null,
            createdAt,
            lastUpdatedAt: createdAt
        };

        expect(task.ttl).toBeNull();
    });

    it('should validate task with statusMessage field', () => {
        const createdAt = new Date().toISOString();
        const task: Task = {
            taskId: 'test-789',
            status: 'failed',
            ttl: null,
            createdAt,
            lastUpdatedAt: createdAt,
            statusMessage: 'Operation failed due to timeout'
        };

        expect(task.statusMessage).toBe('Operation failed due to timeout');
    });

    it('should validate task with createdAt in ISO 8601 format', () => {
        const now = new Date();
        const createdAt = now.toISOString();
        const task: Task = {
            taskId: 'test-iso',
            status: 'working',
            ttl: 30_000,
            createdAt,
            lastUpdatedAt: createdAt
        };

        expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(new Date(task.createdAt).getTime()).toBe(now.getTime());
    });

    it('should validate task with lastUpdatedAt in ISO 8601 format', () => {
        const now = new Date();
        const createdAt = now.toISOString();
        const task: Task = {
            taskId: 'test-iso',
            status: 'working',
            ttl: 30_000,
            createdAt,
            lastUpdatedAt: createdAt
        };

        expect(task.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should validate all task statuses', () => {
        const statuses: Task['status'][] = ['working', 'input_required', 'completed', 'failed', 'cancelled'];

        const createdAt = new Date().toISOString();
        for (const status of statuses) {
            const task: Task = {
                taskId: `test-${status}`,
                status,
                ttl: null,
                createdAt,
                lastUpdatedAt: createdAt
            };
            expect(task.status).toBe(status);
        }
    });
});
