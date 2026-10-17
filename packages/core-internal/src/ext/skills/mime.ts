const BY_EXTENSION: Readonly<Record<string, string>> = {
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    json: 'application/json',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    py: 'text/x-python',
    sh: 'application/x-sh',
    bash: 'application/x-sh',
    js: 'text/javascript',
    mjs: 'text/javascript',
    ts: 'text/typescript',
    html: 'text/html',
    css: 'text/css',
    csv: 'text/csv',
    xml: 'application/xml',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf'
};

const TEXTUAL = new Set(['application/json', 'application/yaml', 'application/x-sh', 'application/xml', 'image/svg+xml']);

/** MIME type from the file extension; `application/octet-stream` when unknown. */
export function mimeTypeFor(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0) return 'application/octet-stream';
    return BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/** True for types served as `text` when the bytes decode losslessly. */
export function isTextualMimeType(mimeType: string): boolean {
    return mimeType.startsWith('text/') || TEXTUAL.has(mimeType);
}
