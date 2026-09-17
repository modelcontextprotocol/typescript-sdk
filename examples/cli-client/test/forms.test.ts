import { describe, expect, it } from 'vitest';

import { extractMentions, parsePromptArgs } from '../host/loop';
import { collectFormInput, describeField, parseFieldAnswer } from '../host/ui';
import { ScriptedUI } from '../script/scriptedUi';

const SCHEMA = {
    type: 'object' as const,
    properties: {
        confirm: { type: 'boolean' as const, title: 'Really?' },
        count: { type: 'string' as const, enum: ['5', '10', '20', '50', 'custom'] },
        name: { type: 'string' as const, description: 'Your name' }
    },
    required: ['confirm', 'count']
};

describe('elicitation form helpers', () => {
    it('describes fields with their constraints', () => {
        expect(describeField('confirm', SCHEMA.properties.confirm, true)).toContain('Really?');
        expect(describeField('confirm', SCHEMA.properties.confirm, true)).toContain('(required)');
        expect(describeField('count', SCHEMA.properties.count, false)).toContain('options: 5, 10, 20, 50, custom');
    });

    it('parses answers per primitive type and rejects invalid values', () => {
        expect(parseFieldAnswer({ type: 'boolean' }, 'y')).toBe(true);
        expect(parseFieldAnswer({ type: 'boolean' }, 'maybe')).toBeUndefined();
        expect(parseFieldAnswer({ type: 'integer', minimum: 1, maximum: 10 }, '5')).toBe(5);
        expect(parseFieldAnswer({ type: 'integer', minimum: 1, maximum: 10 }, '50')).toBeUndefined();
        expect(parseFieldAnswer({ type: 'integer' }, '2.5')).toBeUndefined();
        expect(parseFieldAnswer({ type: 'string', enum: ['a', 'b'] }, 'c')).toBeUndefined();
        expect(parseFieldAnswer({ type: 'array', items: { type: 'string', enum: ['x', 'y'] } }, 'x, y')).toEqual(['x', 'y']);
    });

    it('collects a full form through the UI', async () => {
        const ui = new ScriptedUI({ askAnswers: ['y', '10', 'Felix'] });
        const result = await collectFormInput(ui, SCHEMA);
        expect(result).toEqual({ action: 'accept', content: { confirm: true, count: '10', name: 'Felix' } });
        expect(ui.questions.some(question => question.includes('Really?'))).toBe(true);
    });

    it('treats decline and cancel as terminal answers and retries invalid input', async () => {
        expect(await collectFormInput(new ScriptedUI({ askAnswers: ['decline'] }), SCHEMA)).toEqual({ action: 'decline' });
        expect(await collectFormInput(new ScriptedUI({ askAnswers: ['cancel'] }), SCHEMA)).toEqual({ action: 'cancel' });
        const retrying = new ScriptedUI({ askAnswers: ['maybe', 'y', '10', ''] });
        expect(await collectFormInput(retrying, SCHEMA)).toEqual({ action: 'accept', content: { confirm: true, count: '10' } });
    });

    it('cancels rather than accepting when a required field never gets a valid answer', async () => {
        const ui = new ScriptedUI({ askAnswers: ['maybe', 'maybe', 'maybe'] });
        expect(await collectFormInput(ui, SCHEMA)).toEqual({ action: 'cancel' });
    });
});

describe('input parsing', () => {
    it('extracts @server:uri mentions', () => {
        const { text, mentions } = extractMentions('@todos:todos://board what should I do first?');
        expect(mentions).toEqual(['todos:todos://board']);
        expect(text).toContain('what should I do first?');
    });

    it('parses key=value prompt arguments, including quoted values', () => {
        expect(parsePromptArgs('focus=cli-client note="ship it today"')).toEqual({ focus: 'cli-client', note: 'ship it today' });
    });
});
