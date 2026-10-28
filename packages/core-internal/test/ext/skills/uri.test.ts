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
    skillRootUri,
    trimTrailingSlashes
} from '../../../src/ext/skills/uri';

describe('uri helpers', () => {
    it('joins and percent-encodes segments so they survive new URL()', () => {
        const uri = joinUri('skill://', ['acme', 'refunds', 'templates', 'Purchase Order.md']);
        expect(uri).toBe('skill://acme/refunds/templates/Purchase%20Order.md');
        expect(isRoundTripUri(uri)).toBe(true);
        expect(joinUri('github://owner/repo/skills/', ['x', 'SKILL.md'])).toBe('github://owner/repo/skills/x/SKILL.md');
        expect(joinUri('github://owner/repo/skills///', ['x'])).toBe('github://owner/repo/skills/x');
    });

    it('trims only trailing slashes, in linear time on a long run of them', () => {
        expect(trimTrailingSlashes('a/b//')).toBe('a/b');
        expect(trimTrailingSlashes('a/b')).toBe('a/b');
        expect(trimTrailingSlashes('///')).toBe('');
        expect(trimTrailingSlashes('')).toBe('');
        // CodeQL js/polynomial-redos: `/\/+$/` takes ~4 s on this input; the loop takes well under 1 ms.
        const slashes = `x${'/'.repeat(100_000)}y`;
        const startTime = Date.now();
        expect(trimTrailingSlashes(slashes)).toBe(slashes);
        expect(Date.now() - startTime).toBeLessThan(100);
    });

    it.each(['Q&A.md', 'c++.md', '[draft].md', 'me@home.md', 'a,b;c=d$e|f!(g)*~h.md', 'Purchase Order.md', 'Remboursé.md', 'x{y}z.md'])(
        'publishes %s exactly as new URL() resolves the plain name against the root',
        name => {
            const published = joinUri('skill://acme/refunds', [name]);
            expect(published).toBe(new URL(name, 'skill://acme/refunds/').href);
            expect(isRoundTripUri(published)).toBe(true);
        }
    );

    it('encodes ^ on every runtime, and keys a host that leaves it raw alike', () => {
        const root = 'skill://acme/refunds';
        const published = joinUri(root, ['x^y.md']);
        expect(published).toBe('skill://acme/refunds/x%5Ey.md');
        // Node 24 resolves `x^y.md` to `x%5Ey.md`; Node 20 and 22 leave the `^` raw.
        for (const uri of [published, 'skill://acme/refunds/x^y.md', new URL('x^y.md', `${root}/`).href]) {
            expect(skillFileKey(root, uri)).toBe(published);
        }
    });

    it.each([
        ['me@home', 'me%40home'],
        ['acme:prod', 'acme%3Aprod'],
        ['[draft]', '%5Bdraft%5D'],
        ['a|b', 'a%7Cb']
    ])('encodes a first segment %s strictly, since it is the authority of a skill:// URI', (first, authority) => {
        const uri = joinUri('skill://', [first, 'refunds', 'SKILL.md']);
        expect(uri).toBe(`skill://${authority}/refunds/SKILL.md`);
        expect(isRoundTripUri(uri)).toBe(true);
        expect(new URL(uri).host).toBe(authority);
        expect(resolveSkillRef(uri, 'references/Q&A.md')).toBe(`skill://${authority}/refunds/references/Q&A.md`);
        // Below the authority, path segments follow the path rules.
        expect(joinUri(`skill://${authority}`, [first])).toBe(`skill://${authority}/${first}`);
    });

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
        expect(() => joinUri('skill://', ['x\uD800', 'SKILL.md'])).toThrow(URIError);
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

    it.each([
        '100% off.md',
        '50% résumé.md',
        'x%zz é.md',
        'a % b.md',
        '10%Dec.md',
        '50%Fee.md',
        '100%Beef.md',
        '2%Ad.md',
        '50%ff.md',
        '100%Cake.md',
        '20%E2 x.md',
        '%Café.md'
    ])('keys %s, a name with a stray %, as published whatever follows it', name => {
        const root = 'skill://acme/refunds';
        expect(skillFileKey(root, new URL(name, `${root}/`).href)).toBe(joinUri(root, [name]));
        expect(skillFileKey(root, joinUri(root, [name]))).toBe(joinUri(root, [name]));
    });

    it.each(['10%Dec.md', '%FF', 'a%2Fb', 'é%', '😀%41', '%41.md'])('keys the published URI of %s as itself', name => {
        const root = 'skill://acme/refunds';
        const published = joinUri(root, [name]);
        expect(skillFileKey(root, published)).toBe(published);
    });

    it('keys an escape that does not start valid UTF-8 as a literal %, as encodeSegment publishes it', () => {
        const root = 'skill://acme/refunds';
        const key = (segment: string): string | undefined => skillFileKey(root, `${root}/${segment}`);
        expect(key('%ff%41.md')).toBe(`${root}/%25ffA.md`);
        expect(key('%c3%a9%C3.md')).toBe(`${root}/%C3%A9%25C3.md`);
        // Overlong, surrogate, out-of-range and truncated sequences are not UTF-8: each of their `%` is literal.
        expect(key('%C0%80')).toBe(`${root}/%25C0%2580`);
        expect(key('%ED%A0%80')).toBe(`${root}/%25ED%25A0%2580`);
        expect(key('%F4%90%80%80')).toBe(`${root}/%25F4%2590%2580%2580`);
        expect(key('%e2%82')).toBe(`${root}/%25e2%2582`);
        expect(key('%f0%9f%98%80')).toBe(`${root}/%F0%9F%98%80`);
        // Decoding never carries a slash out of its segment.
        expect(key('%2E%2E%2F')).toBe(`${root}/..%2F`);
        expect(isWithin(root, `${root}/..%2F`)).toBe(false);
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
