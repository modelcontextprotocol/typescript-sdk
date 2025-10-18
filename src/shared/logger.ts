/**
 * LogLevel - SysLog RFC5424 compliant log levels
 *
 * @see RFC5424: https://tools.ietf.org/html/rfc5424
 */
export interface LogLevels {
    emerg: number;
    alert: number;
    crit: number;
    error: number;
    warning: number;
    notice: number;
    info: number;
    debug: number;
  }

export const LogLevels: LogLevels = {
    emerg: 0,
    alert: 1,
    crit: 2,
    error: 3,
    warning: 4,
    notice: 5,
    info: 6,
    debug: 7
  };

/**
 * Logger - SysLog RFC5424 compliant logger type
 *
 * @see RFC5424: https://tools.ietf.org/html/rfc5424
 */
export type Logger = {
    [Level in keyof LogLevels]: (message: string, extra?: Record<string, unknown>) => void;
};

/**
 * Console logger implementation of the Logger interface, to be used by default if no custom logger is provided.
 *
 * @remarks
 * The console logger will log to the console.
 *
 * The console logger will log at the following levels:
 * - log (alias for console.debug)
 * - info
 * - error
 */
export const consoleLogger: Logger = {
    debug: (message, extra) => {
        console.log(message, extra);
    },
    info: (message, extra) => {
        console.info(message, extra);
    },
    notice: (message, extra) => {
        console.info(message, extra);
    },
    warning: (message, extra) => {
        console.warn(message, extra);
    },
    error: (message, extra) => {
        console.error(message, extra);
    },
    crit: (message, extra) => {
        console.error(message, extra);
    },
    alert: (message, extra) => {
        console.error(message, extra);
    },
    emerg: (message, extra) => {
        console.error(message, extra);
    }
};
