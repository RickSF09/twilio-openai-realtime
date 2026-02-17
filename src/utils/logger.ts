import { config } from './config';
import { addLogContext, getLogContext, runWithLogContext } from './logContext';
import { alertsService } from '../services/alertsService';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
type JsonRecord = Record<string, unknown>;

class Logger {
  private isDevelopment = config.server.nodeEnv === 'development';
  private readonly redactKeyPattern = /(authorization|token|api[-_]?key|secret|password|cookie|set-cookie)/i;
  private readonly bulkyKeyPattern = /(payload|transcript|instructions|prompt|audio)/i;
  private readonly maxDepth = 6;
  private readonly maxStringLength = 4000;
  private readonly maxArrayItems = 50;

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return Object.prototype.toString.call(value) === '[object Object]';
  }

  private truncateString(value: string): string {
    if (value.length <= this.maxStringLength) {
      return value;
    }

    return `${value.slice(0, this.maxStringLength)}...[truncated ${value.length - this.maxStringLength} chars]`;
  }

  private sanitize(value: unknown, keyPath = '', depth = 0, seen?: WeakSet<object>): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (depth > this.maxDepth) {
      return '[Truncated depth]';
    }

    if (typeof value === 'string') {
      if (this.bulkyKeyPattern.test(keyPath) && value.length > 200) {
        return `[Truncated ${keyPath || 'field'} ${value.length} chars]`;
      }
      return this.truncateString(value);
    }

    if (
      typeof value === 'number'
      || typeof value === 'boolean'
      || typeof value === 'bigint'
    ) {
      return value;
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack ? this.truncateString(value.stack) : undefined,
      };
    }

    if (Buffer.isBuffer(value)) {
      return `[Buffer ${value.byteLength} bytes]`;
    }

    if (Array.isArray(value)) {
      const baseSeen = seen || new WeakSet<object>();
      const sliced = value.slice(0, this.maxArrayItems);
      const sanitized = sliced.map((item) => this.sanitize(item, keyPath, depth + 1, baseSeen));
      if (value.length > this.maxArrayItems) {
        sanitized.push(`[Truncated ${value.length - this.maxArrayItems} items]`);
      }
      return sanitized;
    }

    if (!this.isPlainObject(value)) {
      return String(value);
    }

    const baseSeen = seen || new WeakSet<object>();
    if (baseSeen.has(value)) {
      return '[Circular]';
    }
    baseSeen.add(value);

    const output: JsonRecord = {};
    for (const [key, nested] of Object.entries(value)) {
      const nextPath = keyPath ? `${keyPath}.${key}` : key;
      if (this.redactKeyPattern.test(key)) {
        output[key] = '[REDACTED]';
        continue;
      }
      output[key] = this.sanitize(nested, nextPath, depth + 1, baseSeen);
    }

    return output;
  }

  private emit(level: LogLevel, message: string, meta?: unknown): void {
    if (level === 'debug' && !this.isDevelopment) {
      return;
    }

    const payload: JsonRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...getLogContext(),
    };

    if (meta !== undefined) {
      if (this.isPlainObject(meta)) {
        const sanitizedMeta = this.sanitize(meta);
        if (this.isPlainObject(sanitizedMeta)) {
          for (const [key, value] of Object.entries(sanitizedMeta)) {
            if (key in payload || key === 'timestamp' || key === 'level' || key === 'message') {
              payload[`meta_${key}`] = value;
            } else {
              payload[key] = value;
            }
          }
        } else {
          payload.meta = sanitizedMeta;
        }
      } else {
        payload.meta = this.sanitize(meta);
      }
    }

    const line = JSON.stringify(payload);

    if (level === 'error') {
      console.error(line);
      void alertsService.notifyFromLog(payload);
      return;
    }

    if (level === 'warn') {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  info(message: string, meta?: unknown): void {
    this.emit('info', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.emit('warn', message, meta);
  }

  error(message: string, error?: unknown): void {
    this.emit('error', message, error);
  }

  debug(message: string, meta?: unknown): void {
    this.emit('debug', message, meta);
  }

  addContext(context: Record<string, unknown>): void {
    addLogContext(context);
  }

  runWithContext<T>(context: Record<string, unknown>, fn: () => T): T {
    return runWithLogContext(context, fn);
  }
}

export const logger = new Logger();
