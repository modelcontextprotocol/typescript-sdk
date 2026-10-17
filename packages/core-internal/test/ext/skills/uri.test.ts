import { describe, expect, it } from 'vitest';

import {
    canonicalUri,
    compareUris,
    encodeSegment,
    isRoundTripUri,
    isWithin,
    joinUri,
    lastSegmentOf,
    resolveSkillRef,
    skillFileKey,
    skillRootUri
} from '../../../src/ext/skills/uri';

describe('uri helpers', () => {
    it('joins and percent-encodes segments so they survive new URL()', () => {
        const uri = joinUri('skill://', ['acme', 'refunds', 'templates', 'Purchase Order.md']);
        expect(uri).toBe('skill://acme/refunds/templates/Purchase%20Order.md');
        expect(isRoundTripUri(uri)).toBe(true);
        expect(joinUri('github://owner/repo/skills/', ['x', 'SKILL.md'])).toBe('github://owner/repo/skills/x/SKILL.md');
    });

    it.each(['Q&A.md', 'c++.md', '[draft].md', 'me@home.md', 'a,b;c=d$e|f!(g)*~h.md', 'Purchase Order.md', 'Remboursé.md', 'x^y{z}.md'])(
        'publishes %s exactly as new URL() resolves the plain name against the root',
        name => {
            const published = joinUri('skill://acme/refunds', [name]);
            expect(published).toBe(new URL(name, 'skill://acme/refunds/').href);
            expect(isRoundTripUri(published)).toBe(true);
        }
    );

    it('always encodes the characters that would change what a segment means', () => {
        expect(encodeSegment('100%.md')).toBe('100%25.md');
        expect(encodeSegment(String.raw`a/b?c#d\e`)).toBe('a%2Fb%3Fc%23d%5Ce');
        expect(encodeSegment('a:b.md')).toBe('a:b.md');
        expect(encodeSegment('Remboursé.md')).toBe('Rembours%C3%A9.md');
    });

    it('encodes the dots of a "." or ".." segment, which WHATWG URL still reads as a dot segment', () => {
        expect(encodeSegment('.')).toBe('%2E');
        expect(encodeSegment('..')).toBe('%2E%2E');
        expect(encodeSegment('...')).toBe('...');
        expect(isRoundTripUri(joinUri('skill://acme/refunds', ['..', 'x.md']))).toBe(false);
        expect(isWithin('skill://acme/refunds', joinUri('skill://acme/refunds', ['..', 'x.md']))).toBe(false);
    });

    it('throws URIError for a lone surrogate', () => {
        expect(() => encodeSegment('x\uD800.md')).toThrow(URIError);
        expect(() => joinUri('skill://acme', ['empty\uDC00'])).toThrow(URIError);
    });

    it('keys every spelling of one file below the root alike', () => {
        const root = 'skill://acme/refunds';
        for (const uri of ['skill://acme/refunds/Q&A.md', 'skill://acme/refunds/Q%26A.md', 'skill://acme/refunds/%51&A.md#part']) {
            expect(skillFileKey(root, uri)).toBe('skill://acme/refunds/Q&A.md');
        }
        expect(skillFileKey(root, 'skill://acme/refunds/r%c3%a9sum%C3%A9.md')).toBe('skill://acme/refunds/r%C3%A9sum%C3%A9.md');
        expect(skillFileKey(root, 'skill://acme/refunds/100%.md')).toBe('skill://acme/refunds/100%25.md');
        expect(skillFileKey(root, 'skill://acme/refunds/100%25.md')).toBe('skill://acme/refunds/100%25.md');
        expect(skillFileKey(root, 'skill://acme/refunds/x%2Fy.md')).toBe('skill://acme/refunds/x%2Fy.md');
        expect(skillFileKey(root, 'skill://acme/refunds/x.md?v=1')).toBe('skill://acme/refunds/x.md?v=1');
        expect(skillFileKey(root, 'skill://acme/refunds/x.md?')).toBe('skill://acme/refunds/x.md?');
        expect(skillFileKey(root, 'skill://acme/other/x.md#f')).toBe('skill://acme/other/x.md');
        expect(skillFileKey(root, 'not a uri')).toBeUndefined();
    });

    it('finds the skill root and its last segment', () => {
        expect(skillRootUri('skill://acme/billing/refunds/SKILL.md')).toBe('skill://acme/billing/refunds');
        expect(skillRootUri('skill://git-workflow/SKILL.md')).toBe('skill://git-workflow');
        expect(skillRootUri('skill://git-workflow/README.md')).toBeUndefined();
        expect(skillRootUri('skill://acme//SKILL.md')).toBeUndefined();
        expect(skillRootUri('skill://acme/refunds//SKILL.md')).toBeUndefined();
        expect(skillRootUri('skill://SKILL.md')).toBeUndefined();
        expect(lastSegmentOf('skill://acme/billing/refunds')).toBe('refunds');
        expect(lastSegmentOf('skill://git-workflow')).toBe('git-workflow');
    });

    it('checks containment after normalisation', () => {
        expect(isWithin('skill://a', 'skill://a/x/y.md')).toBe(true);
        expect(isWithin('skill://a', 'skill://ab/x.md')).toBe(false);
        expect(isWithin('skill://a/b', 'skill://a/b/../c')).toBe(false);
        expect(isWithin('skill://a/b', 'skill://a/b/%2e%2e/c')).toBe(false);
    });

    it('rejects segments that decode to a slash or NUL, but keeps backslashes', () => {
        expect(isWithin('skill://a/b', 'skill://a/b/x%2F..%2F..%2Fetc%2Fpasswd')).toBe(false);
        expect(isWithin('skill://a/b', 'skill://a/b/x%2fy.md')).toBe(false);
        expect(isWithin('skill://a/b', 'skill://a/b/x%00y.md')).toBe(false);
        const backslash = joinUri('skill://a/b', ['dir\\name.md']);
        expect(backslash).toBe('skill://a/b/dir%5Cname.md');
        expect(isWithin('skill://a/b', backslash)).toBe(true);
    });

    it('resolves references against the skill root as the spec examples do', () => {
        const skill = 'skill://acme/billing/refunds/SKILL.md';
        expect(resolveSkillRef(skill)).toBe(skill);
        expect(resolveSkillRef(skill, 'references/GUIDE.md')).toBe('skill://acme/billing/refunds/references/GUIDE.md');
        expect(resolveSkillRef(skill, './templates/Purchase Order.md')).toBe('skill://acme/billing/refunds/templates/Purchase%20Order.md');
        expect(resolveSkillRef(skill, '../other/SKILL.md')).toBe('skill://acme/billing/other/SKILL.md');
        expect(resolveSkillRef(skill, 'skill://acme/billing/refunds/scripts/run.sh')).toBe('skill://acme/billing/refunds/scripts/run.sh');
        expect(() => resolveSkillRef('skill://acme/README.md', 'x')).toThrow(TypeError);
    });

    it('canonicalUri returns undefined for non-URIs', () => {
        expect(canonicalUri('not a uri')).toBeUndefined();
    });

    it('orders URIs by code unit, whatever the locale', () => {
        expect(['skill://b', 'skill://a/SKILL.md', 'skill://B', 'skill://a/b'].toSorted((a, b) => compareUris(a, b))).toEqual([
            'skill://B',
            'skill://a/SKILL.md',
            'skill://a/b',
            'skill://b'
        ]);
    });
});
