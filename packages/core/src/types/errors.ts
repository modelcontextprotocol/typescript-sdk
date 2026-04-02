import { ProtocolErrorCode } from './enums.js';
import type { ElicitRequestURLParams } from './types.js';

/**
 * Protocol errors are JSON-RPC errors that cross the wire as error responses.
 * They use numeric error codes from the {@linkcode ProtocolErrorCode} enum.
 */
export class ProtocolError extends Error {
    constructor(
        public readonly code: number,
        message: string,
        public readonly data?: unknown
    ) {
        super(message);
        this.name = 'ProtocolError';
    }

    /**
     * Factory method to create the appropriate error type based on the error code and data
     */
    static fromError(code: number, message: string, data?: unknown): ProtocolError {
        // Check for specific error types
        if (code === ProtocolErrorCode.UrlElicitationRequired && data) {
            const errorData = data as { elicitations?: unknown[] };
            if (errorData.elicitations) {
                return new UrlElicitationRequiredError(errorData.elicitations as ElicitRequestURLParams[], message);
            }
        }

        // Default to generic ProtocolError
        return new ProtocolError(code, message, data);
    }
}

/**
 * Specialized error type when a tool requires a URL mode elicitation.
 * This makes it nicer for the client to handle since there is specific data to work with instead of just a code to check against.
 */
export class UrlElicitationRequiredError extends ProtocolError {
    constructor(elicitations: ElicitRequestURLParams[], message: string = `URL elicitation${elicitations.length > 1 ? 's' : ''} required`) {
        super(ProtocolErrorCode.UrlElicitationRequired, message, {
            elicitations: elicitations
        });
    }

    get elicitations(): ElicitRequestURLParams[] {
        return (this.data as { elicitations: ElicitRequestURLParams[] })?.elicitations ?? [];
    }
}
