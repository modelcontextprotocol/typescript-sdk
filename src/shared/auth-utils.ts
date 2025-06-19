/**
 * Utilities for handling OAuth resource URIs.
 */

/**
 * Converts a server URL to a resource URL by removing the fragment.
 * RFC 8707 section 2 states that resource URIs "MUST NOT include a fragment component".
 * Keeps everything else unchanged (scheme, domain, port, path, query).
 */
export function resourceUrlFromServerUrl(url: URL): URL {
  const resourceURL = new URL(url.href);
  resourceURL.hash = ''; // Remove fragment
  return resourceURL;
}
