import { AsyncLocalStorage } from 'node:async_hooks';

export type LogContext = Record<string, string | number | boolean>;

const store = new AsyncLocalStorage<LogContext>();

function cleanContext(input: Record<string, unknown>): LogContext {
  const output: LogContext = {};

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
      continue;
    }

    output[key] = String(value);
  }

  return output;
}

export function getLogContext(): LogContext {
  return store.getStore() || {};
}

export function addLogContext(partial: Record<string, unknown>): void {
  const next = cleanContext(partial);
  if (Object.keys(next).length === 0) {
    return;
  }

  const current = store.getStore() || {};
  store.enterWith({
    ...current,
    ...next,
  });
}

export function runWithLogContext<T>(partial: Record<string, unknown>, fn: () => T): T {
  const current = store.getStore() || {};
  const next = cleanContext(partial);

  return store.run(
    {
      ...current,
      ...next,
    },
    fn
  );
}
