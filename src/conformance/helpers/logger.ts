/**
 * Simple logger with configurable log levels.
 * Set to 'error' in tests to suppress debug output.
 */

export type LogLevel = 'debug' | 'error';

let currentLogLevel: LogLevel = 'debug';

export function setLogLevel(level: LogLevel): void {
  currentLogLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLogLevel;
}

export const logger = {
  debug: (...args: unknown[]): void => {
    if (currentLogLevel === 'debug') {
      console.log(...args);
    }
  },
  error: (...args: unknown[]): void => {
    console.error(...args);
  }
};
