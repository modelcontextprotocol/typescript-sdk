import { AuthInfo } from "../auth/types.js";

/**
 * Headers that are compatible with both Node.js and the browser.
 */
export type IsomorphicHeaders = Record<string, string | string[] | undefined>;

/**
 * Information about the incoming request.
 */
export interface RequestInfo {
  /**
   * The headers of the request.
   */
  headers: IsomorphicHeaders;
}

/**
 * Extra information about a message.
 */
export interface MessageExtraInfo {
  /**
   * The request information.
   */
  requestInfo: RequestInfo;

  /**
   * The authentication information.
   */
  authInfo?: AuthInfo;
}