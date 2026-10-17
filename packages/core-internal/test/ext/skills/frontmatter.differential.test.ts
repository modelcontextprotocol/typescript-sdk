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
    'name: x\ndescription: d\nflow: [-a, ?b, :c]\nmap: {-k: v, ?k: w}\n'
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
    'map: {&a k: v}\n'
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
    'a: "\\U00110000"\n'
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
