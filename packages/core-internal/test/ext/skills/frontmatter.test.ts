import { describe, expect, it } from 'vitest';

import { FrontmatterError, parseFrontmatterYaml, parseSkillMarkdown, splitFrontmatter } from '../../../src/ext/skills/frontmatter';

describe('splitFrontmatter', () => {
    it('splits frontmatter and body', () => {
        expect(splitFrontmatter('---\nname: a\n---\n# Body\n')).toEqual({ yaml: 'name: a\n', body: '# Body\n' });
    });

    it('accepts CRLF line endings and a leading UTF-8 BOM', () => {
        expect(splitFrontmatter('\uFEFF---\r\nname: a\r\n---\r\nBody\r\n')).toEqual({ yaml: 'name: a\n', body: 'Body\n' });
    });

    it('rejects a file without frontmatter or without a closing line', () => {
        expect(() => splitFrontmatter('# no frontmatter')).toThrow(FrontmatterError);
        expect(() => splitFrontmatter('---\nname: a\n')).toThrow(/closing/);
    });
});

describe('parseFrontmatterYaml: scalars', () => {
    it('types unquoted values with the YAML 1.2 core schema', () => {
        expect(
            parseFrontmatterYaml(
                ['a: true', 'b: False', 'c: ~', 'd:', 'e: 42', 'f: -1.5', 'g: 1e3', 'h: 0x1F', 'i: 0o17', 'j: .5', 'k: yes', 'l: 1.0'].join(
                    '\n'
                )
            )
        ).toEqual({ a: true, b: false, c: null, d: null, e: 42, f: -1.5, g: 1000, h: 31, i: 15, j: 0.5, k: 'yes', l: 1 });
    });

    it('keeps quoted values as strings and decodes escapes', () => {
        expect(
            parseFrontmatterYaml(String.raw`a: "1.0"` + '\n' + String.raw`b: 'it''s'` + '\n' + String.raw`c: "tab\there \u00e9"`)
        ).toEqual({
            a: '1.0',
            b: "it's",
            c: 'tab\there é'
        });
    });

    it('strips comments only when preceded by whitespace', () => {
        expect(parseFrontmatterYaml('lang: c#\nnote: hello # a comment\nurl: http://x.test/a#b')).toEqual({
            lang: 'c#',
            note: 'hello',
            url: 'http://x.test/a#b'
        });
    });

    it('folds multi-line plain values', () => {
        expect(parseFrontmatterYaml('description: first line\n  second line\n\n  after blank')).toEqual({
            description: 'first line second line\nafter blank'
        });
    });
});

describe('parseFrontmatterYaml: block scalars', () => {
    it('reads literal and folded scalars with chomping', () => {
        const yaml = [
            'lit: |',
            '  a',
            '  b',
            '',
            'strip: |-',
            '  x',
            'keep: |+',
            '  y',
            '',
            'fold: >',
            '  one',
            '  two',
            '',
            '  three',
            'next: 1'
        ].join('\n');
        expect(parseFrontmatterYaml(yaml)).toEqual({ lit: 'a\nb\n', strip: 'x', keep: 'y\n\n', fold: 'one two\nthree\n', next: 1 });
    });
});

describe('parseFrontmatterYaml: collections', () => {
    it('reads nested mappings, sequences, compact sequences and flow collections', () => {
        const yaml = [
            'metadata:',
            '  author: example-org',
            '  version: "1.0"',
            'tags:',
            '- a',
            '- b',
            'items:',
            '  - name: x',
            '    value: 1',
            '  - - nested',
            'flow: [a, "b", {k: v}, ]',
            'map: {x: 1, y: [2, 3]}'
        ].join('\n');
        expect(parseFrontmatterYaml(yaml)).toEqual({
            metadata: { author: 'example-org', version: '1.0' },
            tags: ['a', 'b'],
            items: [{ name: 'x', value: 1 }, ['nested']],
            flow: ['a', 'b', { k: 'v' }],
            map: { x: 1, y: [2, 3] }
        });
    });
});

describe('parseFrontmatterYaml: fails closed', () => {
    it.each([
        ['an anchor', 'a: &x 1'],
        ['an alias', 'a: *x'],
        ['a tag', 'a: !!str 1'],
        ['a complex key', '? a\n: b'],
        ['a multi-line flow collection', 'a: [1,\n  2]'],
        ['a multi-line quoted value', 'a: "x\n  y"'],
        ['a duplicate key', 'a: 1\na: 2'],
        ['tab indentation', 'a:\n\tb: 1'],
        ['": " inside a plain value', 'a: b: c'],
        ['a non-finite number', 'a: .inf'],
        ['an indentation indicator', 'a: |2\n  x'],
        ['a top-level sequence', '- a'],
        ['a non-string key', '1: a'],
        ['the __proto__ key', '__proto__: x'],
        ['an unknown escape', String.raw`a: "\q"`],
        ['a directive', '%YAML 1.2\na: 1'],
        ['an unclosed quote', 'a: "x']
    ])('rejects %s', (_label, yaml) => {
        expect(() => parseFrontmatterYaml(yaml)).toThrow(FrontmatterError);
    });

    it('reports the 1-based line number within SKILL.md', () => {
        expect(() => parseSkillMarkdown('---\nname: a\nbad: &x 1\n---\n')).toThrow(/line 3/);
    });

    it('rejects nesting deeper than 32 levels', () => {
        expect(() => parseFrontmatterYaml(`a: ${'['.repeat(40)}${']'.repeat(40)}`)).toThrow(/deeper than 32/);
    });
});

describe('parseSkillMarkdown', () => {
    it('returns frontmatter and body', () => {
        expect(parseSkillMarkdown('---\nname: git-workflow\ndescription: d\n---\n# Git\n')).toEqual({
            frontmatter: { name: 'git-workflow', description: 'd' },
            body: '# Git\n'
        });
    });
});
