/**
 * Frontmatter reader for `SKILL.md` (SEP-2640).
 *
 * Reads the YAML subset real skills use — block mappings and sequences;
 * plain, quoted and block scalars; one-line flow collections; comments — with
 * YAML 1.2 core-schema typing. Anything outside the subset throws a
 * {@linkcode FrontmatterError} instead of being read differently from a full
 * YAML parser. Server catalogs and client verification both call it; it is
 * kept behind this module so it can be swapped for a YAML library.
 */

export class FrontmatterError extends Error {
    readonly line: number | undefined;

    constructor(message: string, line?: number) {
        super(line === undefined ? message : `line ${line}: ${message}`);
        this.name = 'FrontmatterError';
        this.line = line;
    }
}

export interface SplitSkillMarkdown {
    /** The YAML between the opening and closing `---` lines, with LF line endings. */
    yaml: string;
    /** The markdown after the closing `---` line. */
    body: string;
}

export interface ParsedSkillMarkdown {
    frontmatter: Record<string, unknown>;
    body: string;
}

const MAX_DEPTH = 32;

/** Splits `SKILL.md` into its frontmatter YAML and markdown body. */
export function splitFrontmatter(markdown: string): SplitSkillMarkdown {
    let text = markdown.replaceAll('\r\n', '\n');
    if (text.codePointAt(0) === 0xfe_ff) text = text.slice(1);
    if (!text.startsWith('---\n')) throw new FrontmatterError('SKILL.md must begin with a "---" line', 1);
    const rest = text.slice(4);
    const close = /^---[\t ]*$/m.exec(rest);
    if (close === null) throw new FrontmatterError('frontmatter has no closing "---" line');
    let body = rest.slice(close.index + close[0].length);
    if (body.startsWith('\n')) body = body.slice(1);
    return { yaml: rest.slice(0, close.index), body };
}

/** Splits and parses `SKILL.md`. Line numbers in errors count from the file's first line. */
export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
    const { yaml, body } = splitFrontmatter(markdown);
    return { frontmatter: parseFrontmatterYaml(yaml, 2), body };
}

/** Parses frontmatter YAML into a JSON object. `firstLine` numbers the first YAML line in errors. */
export function parseFrontmatterYaml(yaml: string, firstLine = 1): Record<string, unknown> {
    return new Parser(toLines(yaml, firstLine)).parseDocument();
}

interface Line {
    readonly no: number;
    // Leading spaces only: a tab ends the indentation.
    readonly indent: number;
    // The line after its leading spaces and tabs.
    readonly text: string;
    readonly raw: string;
}

function toLines(yaml: string, firstLine: number): Line[] {
    const raws = yaml.split('\n');
    if (raws.at(-1) === '') raws.pop();
    return raws.map((raw, index) => ({ no: firstLine + index, indent: /^ */.exec(raw)?.[0].length ?? 0, text: trimWhiteStart(raw), raw }));
}

const TAB_INDENT = 'tabs cannot be used for indentation';

const isSkippable = (line: Line): boolean => line.text === '' || line.text.startsWith('#');
const isTabIndented = (line: Line): boolean => line.raw[line.indent] === '\t';
const isSequenceItem = (text: string): boolean => /^-(?:[\t ]|$)/.test(text);

class Parser {
    private index = 0;

    constructor(private readonly lines: Line[]) {}

    parseDocument(): Record<string, unknown> {
        const first = this.peek();
        if (first === undefined) return {};
        // YAML drops a BOM before the first content, so reading it into the first key would differ: fail closed.
        if (first.text.startsWith('\uFEFF')) {
            throw new FrontmatterError('a byte order mark inside the frontmatter is not supported', first.no);
        }
        if (isSequenceItem(first.text) || matchKey(first.text, first.no) === undefined) {
            throw new FrontmatterError('frontmatter must be a mapping of keys to values', first.no);
        }
        const map = this.parseMapping(first.indent, 0);
        const extra = this.peek();
        if (extra !== undefined) throw new FrontmatterError('unexpected content', extra.no);
        return map;
    }

    private peek(): Line | undefined {
        while (this.index < this.lines.length && isSkippable(this.lines[this.index]!)) this.index++;
        const line = this.lines[this.index];
        if (line !== undefined && isTabIndented(line)) throw new FrontmatterError(TAB_INDENT, line.no);
        return line;
    }

    private parseMapping(indent: number, depth: number): Record<string, unknown> {
        assertDepth(depth, this.lines[this.index]?.no);
        const map: Record<string, unknown> = {};
        for (let line = this.peek(); line !== undefined && line.indent >= indent; line = this.peek()) {
            if (line.indent > indent) throw new FrontmatterError('unexpected indentation', line.no);
            if (isSequenceItem(line.text)) break;
            const match = matchKey(line.text, line.no);
            if (match === undefined) throw new FrontmatterError('expected "key: value"', line.no);
            if (Object.hasOwn(map, match.key)) throw new FrontmatterError(`duplicate key "${match.key}"`, line.no);
            this.index++;
            map[match.key] = this.parseValue(match.rest, line, indent, depth + 1, true);
        }
        return map;
    }

    private parseSequence(indent: number, depth: number): unknown[] {
        assertDepth(depth, this.lines[this.index]?.no);
        const items: unknown[] = [];
        for (let line = this.peek(); line !== undefined && line.indent >= indent; line = this.peek()) {
            if (line.indent > indent) throw new FrontmatterError('unexpected indentation', line.no);
            if (!isSequenceItem(line.text)) break;
            const after = line.text.slice(1);
            const rest = trimWhiteStart(after);
            const column = line.indent + 1 + (after.length - rest.length);
            if (rest !== '' && !rest.startsWith('#') && (isSequenceItem(rest) || matchKey(rest, line.no) !== undefined)) {
                // `- key: value` or `- - item`: the item is a block node that starts at `column`.
                if (/^ *\t/.test(after)) throw new FrontmatterError(TAB_INDENT, line.no);
                this.lines[this.index] = { ...line, indent: column, text: rest };
                items.push(isSequenceItem(rest) ? this.parseSequence(column, depth + 1) : this.parseMapping(column, depth + 1));
                continue;
            }
            this.index++;
            items.push(this.parseValue(rest, line, indent, depth + 1, false));
        }
        return items;
    }

    private parseValue(rest: string, line: Line, parentIndent: number, depth: number, allowCompactSequence: boolean): unknown {
        if (rest === '' || rest.startsWith('#')) {
            const next = this.peek();
            if (next !== undefined && next.indent > parentIndent) return this.parseIndented(parentIndent, depth);
            if (allowCompactSequence && next !== undefined && next.indent === parentIndent && isSequenceItem(next.text)) {
                return this.parseSequence(parentIndent, depth);
            }
            return null;
        }
        const first = rest[0]!;
        if (first === '|' || first === '>') return this.parseBlockScalar(rest, line, parentIndent);
        if (first === '"' || first === "'") {
            const { value, end } = readQuoted(rest, 0, line.no);
            expectOnlyComment(rest.slice(end), line.no);
            return value;
        }
        if (first === '[' || first === '{') {
            const { value, end } = readFlow(rest, 0, line.no, depth);
            expectOnlyComment(rest.slice(end), line.no);
            return value;
        }
        if ('&*!'.includes(first)) throw new FrontmatterError('anchors, aliases and tags are not supported', line.no);
        if ('%@`,]}'.includes(first)) throw new FrontmatterError(`"${first}" cannot start a plain value; quote it`, line.no);
        if (isSequenceItem(rest) || /^\?(?:[\t ]|$)/.test(rest)) {
            throw new FrontmatterError('a nested collection must start on its own line', line.no);
        }
        return this.parsePlain(rest, line, parentIndent);
    }

    private parseIndented(parentIndent: number, depth: number): unknown {
        const line = this.peek()!;
        if (isSequenceItem(line.text)) return this.parseSequence(line.indent, depth);
        if (matchKey(line.text, line.no) !== undefined) return this.parseMapping(line.indent, depth);
        this.index++;
        return this.parseValue(line.text, line, parentIndent, depth, false);
    }

    private parsePlain(first: string, line: Line, parentIndent: number): unknown {
        let value = stripComment(first);
        assertPlain(value, line.no);
        let commented = COMMENT.test(first);
        let blanks = 0;
        while (this.index < this.lines.length) {
            const next = this.lines[this.index]!;
            if (next.text === '') {
                blanks++;
                this.index++;
                continue;
            }
            if (next.indent <= parentIndent || next.text.startsWith('#')) break;
            if (isTabIndented(next)) throw new FrontmatterError(TAB_INDENT, next.no);
            if (commented) throw new FrontmatterError('a comment ends a plain value; quote a value that continues past it', next.no);
            const part = stripComment(next.text);
            assertPlain(part, next.no);
            commented = COMMENT.test(next.text);
            value += blanks > 0 ? '\n'.repeat(blanks) : ' ';
            value += part;
            blanks = 0;
            this.index++;
        }
        return resolvePlain(value, line.no);
    }

    private parseBlockScalar(header: string, line: Line, parentIndent: number): string {
        const match = /^([>|])([+-]?)(?:[\t ]+#.*)?[\t ]*$/.exec(header);
        if (match === null) {
            const indicator = /^[>|][+-]?\d|^[>|]\d/.test(header);
            throw new FrontmatterError(
                indicator ? 'block scalar indentation indicators are not supported' : 'invalid block scalar header',
                line.no
            );
        }
        const contents: string[] = [];
        let contentIndent = -1;
        let leadingWidth = 0;
        while (this.index < this.lines.length) {
            const next = this.lines[this.index]!;
            const spacesOnly = next.indent === next.raw.length;
            if (contentIndent === -1 && !spacesOnly && next.indent > parentIndent) {
                contentIndent = next.indent;
                if (leadingWidth > contentIndent) {
                    throw new FrontmatterError('a leading blank line is indented more than the block scalar content', next.no);
                }
            }
            if (contentIndent !== -1 && next.indent >= contentIndent) {
                contents.push(next.raw.slice(contentIndent));
            } else if (spacesOnly) {
                if (contentIndent === -1) leadingWidth = Math.max(leadingWidth, next.indent);
                contents.push('');
            } else if (isTabIndented(next)) {
                throw new FrontmatterError(TAB_INDENT, next.no);
            } else {
                break;
            }
            this.index++;
        }
        return foldBlock(contents, match[1] === '>', match[2] ?? '');
    }
}

function assertDepth(depth: number, line: number | undefined): void {
    if (depth > MAX_DEPTH) throw new FrontmatterError(`nesting deeper than ${MAX_DEPTH} levels is not supported`, line);
}

interface KeyMatch {
    key: string;
    rest: string;
}

function matchKey(text: string, no: number): KeyMatch | undefined {
    const first = text[0];
    if (first === '"' || first === "'") {
        const { value, end } = readQuoted(text, 0, no);
        const after = text.slice(end);
        if (after === ':' || /^:[\t ]/.test(after)) return { key: checkKey(value, no), rest: trimWhiteStart(after.slice(1)) };
        return undefined;
    }
    if (first === '?') throw new FrontmatterError('complex keys ("?") are not supported', no);
    if (first === undefined || '[]{}&*!|>%@`#,'.includes(first)) return undefined;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        const previous = text[index - 1];
        if (char === '#' && (previous === ' ' || previous === '\t')) return undefined;
        if (char === ':') {
            const next = text[index + 1];
            if (next === undefined || next === ' ' || next === '\t') {
                const key = trimWhiteEnd(text.slice(0, index));
                if (key === '') return undefined;
                return { key: resolveKey(key, no), rest: trimWhiteStart(text.slice(index + 1)) };
            }
        }
    }
    return undefined;
}

function checkKey(key: string, no: number): string {
    if (key === '__proto__') throw new FrontmatterError('the key "__proto__" is not supported', no);
    return key;
}

function resolveKey(raw: string, no: number): string {
    if (typeof resolvePlain(raw, no) !== 'string') throw new FrontmatterError(`key "${raw}" must be a string; quote it`, no);
    return checkKey(raw, no);
}

function assertPlain(text: string, no: number): void {
    if (/:(?:[\t ]|$)/.test(text)) throw new FrontmatterError('a plain value cannot contain ": "; quote the value', no);
}

const COMMENT = /[\t ]#/;

function stripComment(text: string): string {
    const match = COMMENT.exec(text);
    return trimWhiteEnd(match === null ? text : text.slice(0, match.index));
}

function expectOnlyComment(after: string, no: number): void {
    if (trimWhiteStart(after) === '' || /^[\t ]+#/.test(after)) return;
    throw new FrontmatterError('unexpected text after the value', no);
}

// YAML white space is only space and tab; `String.prototype.trim` would also strip Unicode spaces YAML keeps.
function trimWhiteStart(text: string): string {
    return text.slice(skipSpaces(text, 0));
}

function trimWhiteEnd(text: string): string {
    let end = text.length;
    while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
    return text.slice(0, end);
}

const NULL = /^(?:~|null|Null|NULL)$/;
const TRUE = /^(?:true|True|TRUE)$/;
const FALSE = /^(?:false|False|FALSE)$/;
const INTEGER = /^[+-]?\d+$/;
const OCTAL = /^0o[0-7]+$/;
const HEXADECIMAL = /^0x[\dA-Fa-f]+$/;
const FLOAT = /^[+-]?(?:\.\d+|\d+(?:\.\d*)?)(?:[Ee][+-]?\d+)?$/;
const SPECIAL_FLOAT = /^(?:[+-]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

function resolvePlain(text: string, no: number): unknown {
    if (text === '' || NULL.test(text)) return null;
    if (TRUE.test(text)) return true;
    if (FALSE.test(text)) return false;
    let number: number | undefined;
    if (INTEGER.test(text) || FLOAT.test(text)) number = Number(text);
    else if (OCTAL.test(text)) number = Number.parseInt(text.slice(2), 8);
    else if (HEXADECIMAL.test(text)) number = Number.parseInt(text.slice(2), 16);
    else if (SPECIAL_FLOAT.test(text)) number = Number.NaN;
    if (number === undefined) return text;
    if (!Number.isFinite(number)) throw new FrontmatterError(`"${text}" cannot be represented in JSON; quote it`, no);
    return number;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
    '0': '\0',
    a: '\u0007',
    b: '\b',
    t: '\t',
    '\t': '\t',
    n: '\n',
    v: '\v',
    f: '\f',
    r: '\r',
    e: '\u001B',
    ' ': ' ',
    '"': '"',
    '/': '/',
    '\\': '\\',
    N: '\u0085',
    _: '\u00A0',
    L: '\u2028',
    P: '\u2029'
};

const HEX_ESCAPE_WIDTH: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

const UNCLOSED_QUOTE = 'a quoted value must close on the same line (multi-line quoted values are not supported)';

function readQuoted(text: string, start: number, no: number): { value: string; end: number } {
    const quote = text[start];
    let value = '';
    let index = start + 1;
    while (index < text.length) {
        const char = text[index]!;
        if (quote === "'") {
            if (char === "'") {
                if (text[index + 1] === "'") {
                    value += "'";
                    index += 2;
                    continue;
                }
                return { value, end: index + 1 };
            }
            value += char;
            index++;
            continue;
        }
        if (char === '"') return { value, end: index + 1 };
        if (char === '\\') {
            const escape = decodeEscape(text, index, no);
            value += escape.decoded;
            index += escape.length;
            continue;
        }
        value += char;
        index++;
    }
    throw new FrontmatterError(UNCLOSED_QUOTE, no);
}

function decodeEscape(text: string, index: number, no: number): { decoded: string; length: number } {
    const code = text[index + 1];
    if (code === undefined) throw new FrontmatterError(UNCLOSED_QUOTE, no);
    const simple = SIMPLE_ESCAPES[code];
    if (simple !== undefined) return { decoded: simple, length: 2 };
    const width = HEX_ESCAPE_WIDTH[code];
    if (width === undefined) throw new FrontmatterError(`unknown escape "\\${code}"`, no);
    const hex = text.slice(index + 2, index + 2 + width);
    if (hex.length !== width || !/^[\dA-Fa-f]+$/.test(hex) || Number.parseInt(hex, 16) > 0x10_ff_ff) {
        throw new FrontmatterError(`invalid escape "\\${code}${hex}"`, no);
    }
    return { decoded: String.fromCodePoint(Number.parseInt(hex, 16)), length: 2 + width };
}

function skipSpaces(text: string, index: number): number {
    let position = index;
    while (text[position] === ' ' || text[position] === '\t') position++;
    return position;
}

const UNCLOSED_FLOW = 'a flow collection must close on the same line';

function readFlow(text: string, start: number, no: number, depth: number): { value: unknown; end: number } {
    assertDepth(depth, no);
    const open = text[start];
    const close = open === '[' ? ']' : '}';
    const list: unknown[] = [];
    const map: Record<string, unknown> = {};
    let index = skipSpaces(text, start + 1);
    if (text[index] === close) return { value: open === '[' ? list : map, end: index + 1 };
    for (;;) {
        if (open === '[') {
            const item = readFlowValue(text, index, no, depth);
            list.push(item.value);
            index = skipSpaces(text, item.end);
        } else {
            const key = readFlowKey(text, index, no);
            const item = readFlowValue(text, key.end + 1, no, depth);
            if (Object.hasOwn(map, key.key)) throw new FrontmatterError(`duplicate key "${key.key}"`, no);
            map[key.key] = item.value;
            index = skipSpaces(text, item.end);
        }
        const char = text[index];
        if (char === ',') {
            index = skipSpaces(text, index + 1);
            if (text[index] === close) return { value: open === '[' ? list : map, end: index + 1 };
            continue;
        }
        if (char === close) return { value: open === '[' ? list : map, end: index + 1 };
        if (char === undefined) throw new FrontmatterError(UNCLOSED_FLOW, no);
        throw new FrontmatterError(`unexpected "${char}" in a flow collection`, no);
    }
}

function readFlowKey(text: string, start: number, no: number): { key: string; end: number } {
    const index = skipSpaces(text, start);
    const char = text[index];
    if (char === undefined) throw new FrontmatterError(UNCLOSED_FLOW, no);
    if (char === '"' || char === "'") {
        const quoted = readQuoted(text, index, no);
        const colon = skipSpaces(text, quoted.end);
        if (text[colon] !== ':') throw new FrontmatterError('expected ": " after a key in a flow mapping', no);
        return { key: checkKey(quoted.value, no), end: colon };
    }
    if (char === '[' || char === '{') throw new FrontmatterError('complex keys (flow collections as keys) are not supported', no);
    assertFlowPlainStart(text, index, no);
    const end = scanFlowPlain(text, index);
    const raw = trimWhiteEnd(text.slice(index, end));
    const after = text[end + 1];
    if (raw === '' || text[end] !== ':' || (after !== ' ' && after !== '\t')) {
        throw new FrontmatterError('expected "key: value" in a flow mapping', no);
    }
    return { key: resolveKey(raw, no), end };
}

// After `-`, `?` or `:`, any of these makes it an indicator in a flow collection.
const FLOW_SEPARATORS = ' \t,[]{}';

function assertFlowPlainStart(text: string, index: number, no: number): void {
    const char = text[index]!;
    if ('&*!'.includes(char)) throw new FrontmatterError('anchors, aliases and tags are not supported', no);
    if ('|>%@`#'.includes(char) || ('-?:'.includes(char) && FLOW_SEPARATORS.includes(text[index + 1] ?? ' '))) {
        throw new FrontmatterError(`"${char}" cannot start a plain value in a flow collection; quote it`, no);
    }
}

// The end of a plain flow scalar: a flow indicator, a comment or a `:` indicator.
function scanFlowPlain(text: string, index: number): number {
    let end = index;
    while (end < text.length) {
        const char = text[end]!;
        if (',[]{}'.includes(char)) break;
        if (char === '#' && (text[end - 1] === ' ' || text[end - 1] === '\t')) break;
        if (char === ':' && FLOW_SEPARATORS.includes(text[end + 1] ?? ' ')) break;
        end++;
    }
    return end;
}

function readFlowValue(text: string, start: number, no: number, depth: number): { value: unknown; end: number } {
    const index = skipSpaces(text, start);
    const char = text[index];
    if (char === undefined) throw new FrontmatterError(UNCLOSED_FLOW, no);
    if (char === '[' || char === '{') return readFlow(text, index, no, depth + 1);
    if (char === '"' || char === "'") return readQuoted(text, index, no);
    assertFlowPlainStart(text, index, no);
    const end = scanFlowPlain(text, index);
    if (text[end] === ':') throw new FrontmatterError('mappings inside flow collections are not supported; quote the value', no);
    const raw = trimWhiteEnd(text.slice(index, end));
    if (raw === '') throw new FrontmatterError('empty value in a flow collection', no);
    return { value: resolvePlain(raw, no), end };
}

// Joins block scalar lines as YAML does (the algorithm of js-yaml's readBlockScalar).
function foldBlock(contents: readonly string[], folded: boolean, chomping: string): string {
    let result = '';
    let emptyLines = 0;
    let didReadContent = false;
    let atMoreIndented = false;
    for (const content of contents) {
        if (content === '') {
            emptyLines++;
            continue;
        }
        if (folded) {
            if (content.startsWith(' ') || content.startsWith('\t')) {
                atMoreIndented = true;
                result += '\n'.repeat(didReadContent ? 1 + emptyLines : emptyLines);
            } else if (atMoreIndented) {
                atMoreIndented = false;
                result += '\n'.repeat(emptyLines + 1);
            } else if (emptyLines === 0) {
                if (didReadContent) result += ' ';
            } else {
                result += '\n'.repeat(emptyLines);
            }
        } else {
            result += '\n'.repeat(didReadContent ? 1 + emptyLines : emptyLines);
        }
        result += content;
        didReadContent = true;
        emptyLines = 0;
    }
    if (chomping === '+') result += '\n'.repeat(didReadContent ? 1 + emptyLines : emptyLines);
    else if (chomping === '' && didReadContent) result += '\n';
    return result;
}
