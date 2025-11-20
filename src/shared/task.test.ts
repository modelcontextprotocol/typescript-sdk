import { describe, it, expect } from 'vitest';
import { isTerminal } from './task.js';
import type { Task } from '../types.js';

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
        const task: Task = {
            taskId: 'test-123',
            status: 'working',
            ttl: 60000,
            createdAt: new Date().toISOString(),
            pollInterval: 1000
        };

        expect(task.ttl).toBe(60000);
        expect(task.createdAt).toBeDefined();
        expect(typeof task.createdAt).toBe('string');
    });

    it('should validate task with null ttl', () => {
        const task: Task = {
            taskId: 'test-456',
            status: 'completed',
            ttl: null,
            createdAt: new Date().toISOString()
        };

        expect(task.ttl).toBeNull();
    });

    it('should validate task with statusMessage field', () => {
        const task: Task = {
            taskId: 'test-789',
            status: 'failed',
            ttl: null,
            createdAt: new Date().toISOString(),
            statusMessage: 'Operation failed due to timeout'
        };

        expect(task.statusMessage).toBe('Operation failed due to timeout');
    });

    it('should validate task with createdAt in ISO 8601 format', () => {
        const now = new Date();
        const task: Task = {
            taskId: 'test-iso',
            status: 'working',
            ttl: 30000,
            createdAt: now.toISOString()
        };

        expect(task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(new Date(task.createdAt).getTime()).toBe(now.getTime());
    });

    it('should validate all task statuses', () => {
        const statuses: Task['status'][] = ['working', 'input_required', 'completed', 'failed', 'cancelled'];

        statuses.forEach(status => {
            const task: Task = {
                taskId: `test-${status}`,
                status,
                ttl: null,
                createdAt: new Date().toISOString()
            };
            expect(task.status).toBe(status);
        });
    });
});
