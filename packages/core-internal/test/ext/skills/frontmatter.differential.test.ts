import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { FrontmatterError, parseFrontmatterYaml } from '../../../src/ext/skills/frontmatter';

/** Real-world-shaped frontmatter the parser must read exactly as a YAML 1.2 library does. */
const ACCEPTED: readonly string[] = [
    'name: pdf-processing\ndescription: Extract PDF text, fill forms, merge files. Use when handling PDFs.\n',
    'name: pdf-processing\ndescription: d\nlicense: Apache-2.0\nmetadata:\n  author: example-org\n  version: "1.0"\n',
    'name: x\ndescription: d\nallowed-tools: Bash(git:*) Bash(jq:*) Read\ndisable-model-invocation: true\nargument-hint: "[file]"\n',
    'name: x\ndescription: >-\n  Extracts text and tables from PDF files,\n  fills PDF forms.\n\n  Use when working with PDFs.\n',
    'name: x\ndescription: |\n  Line one\n  Line two\n\n  Line four\n',
    'name: x\ndescription: >\n  folded\n    more indented\n  back\n',
    'name: x\ndescription: |+\n  keep\n\n\nnext: 1\n',
    'name: x\ndescription: first line\n  continued\n',
    'name: x\ndescription: d\ntags:\n- a\n- b\nitems:\n  - name: one\n    weight: 1.5\n  - name: two\n',
    'name: x\ndescription: d\nflow: [a, "b c", 1, true, null, {k: v}]\nmap: {a: 1, b: [x, y]}\n',
    "name: x\ndescription: 'it''s quoted'\nescaped: \"tab\\tnewline\\nunicode \\u00e9 \\x41\"\n",
    'name: x # trailing comment\n# full-line comment\ndescription: d\nlang: c#\nurl: https://example.test/a#b\n',
    'name: x\ndescription: d\nints: [0, -1, +2, 0x1f, 0o17]\nfloats: [1.0, .5, 1e3, -2.5E-2]\nnulls: [~, null, Null]\nbools: [true, False, TRUE]\nstrings: [yes, no, on, off, 1.2.3]\n',
    'name: x\ndescription: d\nempty:\nquoted-empty: ""\nunicode: "日本語 ✓"\n',
    'name: x\ndescription: d\nnested:\n  level1:\n    level2:\n      - deep\n',
    'name: x\ndescription: d\ntags:\n-\ta\n-\tb\n',
    'name: x\ndescription: d\nflow: [-a, ?b, :c]\nmap: {-k: v, ?k: w}\n',
    'name: x\ndescription: d\nflow: [http://x.test/a, b:c, a#b]\nmap: {a:b: c, :k: v, http://x.test: 1, u: http://x.test, k#: v#}\n',
    // A tab after a block scalar's content indentation is content.
    'name: x\ndescription: |\n  foo\n  \tbar\n',
    'name: x\ndescription: |\n  \tfoo\n  bar\n',
    'name: x\ndescription: |\n \tfoo\n',
    'name: x\ndescription: |\n  \t\n  foo\n',
    'name: x\ndescription: |-\n  foo\n  \t\n',
    'name: x\ndescription: |\n  foo\n  \t# not a comment\n',
    'name: x\ndescription: >\n  a\n  b\n  \tc\n  d\n  e\n',
    'name: x\ndescription: >\n  a\n   b\n  \tc\n  d\n',
    'name: x\ndescription: >\n  foo\n\n  \tbar\n\n  baz\n',
    'name: x\nmetadata:\n  note: |\n    foo\n    \tbar\n  next: "1"\n',
    'name: x\ntags:\n- |\n  foo\n  \tbar\n- x\n'
];

/** Valid YAML the parser deliberately rejects (it must fail closed, never misread). */
const REJECTED: readonly string[] = [
    'base: &b 1\nref: *b\n',
    'value: !!str 1\n',
    'list: [1,\n  2]\n',
    'quoted: "line\n  continued"\n',
    'block: |2\n    indented\n',
    'flow: [? x]\n',
    'flow: [:]\n',
    'map: {? k: v}\n',
    'map: {!t k: v}\n',
    'map: {&a k: v}\n',
    'flow: [x:]\n',
    'flow: [x:, y]\n',
    'flow: [x, y:]\n',
    'flow: [x::]\n',
    'flow: [x:y:]\n',
    'map: {k: [x:]}\n',
    'map: {[x]: y}\n',
    'map: {k: v, [x]: y}\n',
    'map: {{x: 1}: y}\n',
    // yaml drops a byte order mark before the first content; the parser does not guess.
    '\uFEFFname: x\n',
    '# comment\n\uFEFFname: x\n',
    // yaml reads `__proto__` as an own key; the parser rejects it wherever a key can be written.
    '"__proto__": x\n',
    "m:\n  '__proto__': x\n",
    'm: {__proto__: x}\n',
    'm: {"__proto__": x}\n'
];

/** Invalid YAML: the yaml library rejects it, so the parser must too. */
const INVALID: readonly string[] = [
    'a: ,x\n',
    'a: ]x\n',
    'a: ?\tx\n',
    ']k: v\n',
    'a: -\tb\n',
    'k:\n-\tk: v\n',
    'a: [- x]\n',
    'a: [-]\n',
    'a: [|x]\n',
    'a: [#x]\n',
    'a: {- k: v}\n',
    'a: {|k: v}\n',
    'a: x #c\n  y\n',
    'a: |\n   \n  x\n',
    'a: "\\U00110000"\n',
    'a: [x{y]\n',
    'a: [x}y]\n',
    'a: {k: x]y}\n',
    'a: {k: x[y}\n',
    'a: {k: x{y}\n',
    'a: {k: v:}\n',
    'a: {k: v:, j: w}\n',
    'a: {x #y: z}\n',
    'a: {x]: y}\n',
    'a: {x[: y}\n',
    // A tab inside a block scalar's indentation, blank and comment lines included.
    'a: |\n\tfoo\n',
    'a: |\n\t\n  foo\n',
    'a: |\n  foo\n \tbar\n',
    'a: |\n  foo\n\t\n  bar\n',
    'a: |\n    foo\n  \t\n',
    'a: |\n  foo\n\t\nb: 1\n',
    'a: |\n  foo\n\t# c\nb: 1\n',
    'k:\n  a: |\n    foo\n  \tbar\n'
];

/**
 * Characters that JavaScript's `trim` strips (NEL aside, which it keeps) but that YAML 1.2 reads as content: its
 * only white space is space and tab (`s-white`).
 */
const NON_YAML_SPACES: Readonly<Record<string, string>> = {
    'U+00A0': '\u00A0',
    'U+2003': '\u2003',
    'U+3000': '\u3000',
    'U+2028': '\u2028',
    'U+2029': '\u2029',
    'U+FEFF': '\uFEFF',
    'U+000B': '\u000B',
    'U+000C': '\u000C',
    'U+0085': '\u0085'
};

/** Every place the parser skips white space, with `c` where a trim would wrongly drop it. */
const SPACE_POSITIONS: ReadonlyArray<(c: string) => string> = [
    c => `name: x\ndescription: a${c}\n`,
    c => `name: x\ndescription: ${c}a\n`,
    c => `name: x\ndescription: ${c}\n`,
    c => `name${c}: x\n`,
    c => `description: a${c}# not a comment\n`,
    c => `description: a${c}b\n`,
    c => `description: a${c}\n  continued\n`,
    c => `description: a\n  ${c}\n`,
    c => `description: |\n  a${c}\n`,
    c => `tags: [a${c}, ${c}b]\n`,
    c => `map: {k${c}: v${c}}\n`,
    c => `tags:\n- ${c}a\nitems:\n- ${c}k: v\n`
];

const OPTIONS = { version: '1.2', schema: 'core', uniqueKeys: true, merge: false } as const;

describe('frontmatter parser agrees with the yaml library (YAML 1.2 core schema)', () => {
    it.each(ACCEPTED)('reads %j exactly like yaml', source => {
        const expected = YAML.parse(source, OPTIONS) as unknown;
        expect(parseFrontmatterYaml(source)).toEqual(expected);
    });

    it.each(REJECTED)('fails closed on %j', source => {
        expect(() => parseFrontmatterYaml(source)).toThrow(FrontmatterError);
    });

    it.each(INVALID)('rejects %j like yaml', source => {
        expect(() => YAML.parse(source, OPTIONS)).toThrow();
        expect(() => parseFrontmatterYaml(source)).toThrow(FrontmatterError);
    });
});

describe('Unicode white space other than space and tab is content, as in yaml', () => {
    const cases = Object.entries(NON_YAML_SPACES).flatMap(([name, c]) => SPACE_POSITIONS.map(position => [name, position(c)] as const));

    it.each(cases)('%s: reads %j exactly like yaml', (_name, source) => {
        const expected = YAML.parse(source, OPTIONS) as unknown;
        expect(parseFrontmatterYaml(source)).toEqual(expected);
    });

    it.each(Object.entries(NON_YAML_SPACES))('%s after a quoted value is rejected, like yaml', (_name, c) => {
        const source = `description: "a"${c}\n`;
        expect(() => YAML.parse(source, OPTIONS)).toThrow();
        expect(() => parseFrontmatterYaml(source)).toThrow(FrontmatterError);
    });
});
