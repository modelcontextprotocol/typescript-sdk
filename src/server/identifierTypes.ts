import { RequestHandlerExtra } from "../shared/protocol.js";
import { ServerNotification, ServerRequest } from "../types.js";

/**
 * Enhanced request handler extra information that includes identifier-related properties
 * for distributed tracing and multi-tenancy support.
 */
export interface EnhancedRequestHandlerExtra extends RequestHandlerExtra<ServerRequest, ServerNotification> {
  /**
   * Optional identifiers from the request that can be used for distributed tracing,
   * multi-tenancy, or other cross-cutting concerns.
   */
  identifiers?: Record<string, string>;

  /**
   * Helper function to apply request identifiers to outgoing HTTP request options.
   * This automatically forwards identifiers as HTTP headers according to the server's
   * identifier forwarding configuration.
   * 
   * @param requestOptions HTTP request options to enhance with identifier headers
   * @returns The modified request options
   */
  applyIdentifiersToRequestOptions: (requestOptions: { headers?: Record<string, string> }) => 
    { headers?: Record<string, string> };
}
