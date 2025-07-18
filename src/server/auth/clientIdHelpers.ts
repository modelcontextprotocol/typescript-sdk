import dns from 'node:dns';
import { OAuthClientInformationFull } from 'src/shared/auth.js';

/**
 * Reads a limited amount of data from a fetch response, closes the stream, and returns the parsed JSON result.
 * Throws an error if the response contains more data than the limit.
 *
 * @param response The fetch response object
 * @param options Configuration options
 * @returns Parsed JSON data
 */
async function readLimitedJson<T>(
  response: Response,
  options: { maxSizeInBytes?: number } = {}
): Promise<T> {
  const maxSize = options.maxSizeInBytes || 1024 * 1024; // Default to 1MB

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Response body is null or undefined');
  }

  let receivedLength = 0;
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value) {
      chunks.push(value);
      receivedLength += value.length;

      if (receivedLength > maxSize) {
        // Cancel the stream and throw error if we exceed the limit
        await reader.cancel();
        throw new Error(`Response exceeded size limit of ${maxSize} bytes`);
      }
    }
  }

  // Concatenate chunks into a single Uint8Array
  const allChunks = new Uint8Array(receivedLength);
  let position = 0;
  for (const chunk of chunks) {
    allChunks.set(chunk, position);
    position += chunk.length;
  }

  // Convert to text and parse as JSON
  const text = new TextDecoder().decode(allChunks);
  return JSON.parse(text);
}

/**
 * Validates if a URL is using HTTPS and doesn't resolve to an IP in the denylist.
 * By default, the denylist includes private IP ranges.
 *
 * @param url The URL to validate
 * @param options Configuration options
 * @returns Promise that resolves when validation is successful
 * @throws Error if validation fails
 */
async function validatePublicUrl(
  url: URL,
  options: {
    denylist?: RegExp[];
    requireHttps?: boolean;
  } = {}
): Promise<void> {
  // Default options
  const requireHttps = options.requireHttps ?? true;
  const denylist = options.denylist ?? [
    // Private IP ranges
    /^10\./,                             // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,    // 172.16.0.0/12
    /^192\.168\./,                       // 192.168.0.0/16
    /^127\./,                            // 127.0.0.0/8
    /^169\.254\./,                       // 169.254.0.0/16 (link-local)
    /^::1/,                              // localhost in IPv6
    /^f[cd][0-9a-f]{2}:/i,               // IPv6 unique local addresses (fc00::/7)
    /^fe80:/i                            // IPv6 link-local (fe80::/10)
  ];

  // Check if it's HTTPS when required
  if (requireHttps && url.protocol !== 'https:') {
    throw new Error('URL must use HTTPS protocol');
  }

  // Resolve DNS name to IPv4 addresses
  const addresses = await dns.promises.resolve4(url.hostname);

  // Check if any resolved IP is in the denylist
  for (const ip of addresses) {
    if (denylist.some(pattern => pattern.test(ip))) {
      throw new Error('URL resolves to a denied IP address');
    }
  }

  // Could also check IPv6 addresses if needed
  const ipv6Addresses = await dns.promises.resolve6(url.hostname);
  for (const ip of ipv6Addresses) {
    if (denylist.some(pattern => pattern.test(ip))) {
      throw new Error('URL resolves to a denied IP address');
    }
  }
}

export async function fetchClientMetadata(client_id: string): Promise<OAuthClientInformationFull> {
// Check that client_id is a string
  if (typeof client_id !== 'string') {
    throw new Error('Client ID must be a string');
  }

  // Check if client_id is a URL
  let url: URL;
  try {
    url = new URL(client_id);

    // Check that the URL is https, and a public IP etc.
    await validatePublicUrl(url);

    // Fetch the URL
    // TODO: outbound rate limit
    const response = await fetch(client_id);
    if (!response.ok) {
      throw new Error(`Failed to fetch client metadata: ${response.status}`);
    }

    const maxSize = 1024 * 1024; // 1MB
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    if (contentLength > maxSize) {
      throw new Error('Client metadata response too large');
    }

    return readLimitedJson(response, { maxSizeInBytes: maxSize });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error('Client ID must be a valid URL');
    }
    throw error;
  }
}
