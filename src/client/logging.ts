/**
 * Client-side logging utility that suppresses console output in production environments.
 * Logs are shown when NODE_ENV is not set to 'production'.
 */

const isDebugEnabled = (): boolean => {
  // Allow logging unless explicitly in production
  if (typeof process !== "undefined" && process.env) {
    return process.env.NODE_ENV !== "production";
  }
  // If process.env is not available, default to allowing logs
  return true;
};

const debugEnabled = isDebugEnabled();

export const logger = {
  log: (...args: unknown[]): void => {
    if (debugEnabled) {
      console.log(...args);
    }
  },

  warn: (...args: unknown[]): void => {
    if (debugEnabled) {
      console.warn(...args);
    }
  },

  error: (...args: unknown[]): void => {
    if (debugEnabled) {
      console.error(...args);
    }
  },

  debug: (...args: unknown[]): void => {
    if (debugEnabled) {
      console.debug(...args);
    }
  },
};
