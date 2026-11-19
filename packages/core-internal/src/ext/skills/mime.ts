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

/** MIME type from the file extension; `application/octet-stream` when unknown. */
export function mimeTypeFor(fileName: string): string {
    const dot = fileName.lastIndexOf('.');
    if (dot <= 0) return 'application/octet-stream';
    const extension = fileName.slice(dot + 1).toLowerCase();
    // Own keys only: an inherited name such as `__proto__` or `constructor` is not a MIME type.
    return Object.hasOwn(BY_EXTENSION, extension) ? BY_EXTENSION[extension]! : 'application/octet-stream';
}
