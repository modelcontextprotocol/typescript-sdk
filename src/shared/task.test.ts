import { describe, it, expect } from 'vitest';
import { isTerminal } from './task.js';

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
