import { config } from '../utils/config';

type AlertSeverity = 'P1' | 'P2' | 'P3';

interface AlertInput {
  title: string;
  source: string;
  severity?: AlertSeverity;
  dedupeKey?: string;
  details?: Record<string, unknown>;
  error?: unknown;
}

const lastSentAtByKey = new Map<string, number>();

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function trimToMax(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function cleanDetails(details: Record<string, unknown> | undefined): Record<string, string> {
  if (!details) return {};

  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(details)) {
    const serialized = stringifyValue(value).trim();
    if (!serialized) continue;
    const maxLength = key === 'log_payload' ? 8000 : 500;
    clean[key] = trimToMax(serialized, maxLength);
  }

  return clean;
}

function serializeError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      error_name: error.name,
      error_message: error.message,
      error_stack: error.stack ? trimToMax(error.stack, 800) : '',
    };
  }

  const serialized = stringifyValue(error).trim();
  if (!serialized) {
    return {};
  }

  return {
    error_message: trimToMax(serialized, 800),
  };
}

function shouldSendAlert(dedupeKey: string | undefined): boolean {
  if (!dedupeKey) return true;

  const now = Date.now();
  const minIntervalMs = config.alerts.minIntervalSeconds * 1_000;
  const lastSentAt = lastSentAtByKey.get(dedupeKey);

  if (lastSentAt && now - lastSentAt < minIntervalMs) {
    return false;
  }

  lastSentAtByKey.set(dedupeKey, now);
  return true;
}

function buildMessage(input: AlertInput): string {
  const severity = input.severity ?? config.alerts.defaultSeverity;
  const combinedDetails = {
    ...cleanDetails(input.details),
    ...serializeError(input.error),
  };

  const lines: string[] = [
    `[${severity}] ${config.alerts.serviceName}: ${input.title}`,
    `source=${input.source}`,
    `env=${config.server.nodeEnv}`,
    `time=${new Date().toISOString()}`,
  ];

  for (const [key, value] of Object.entries(combinedDetails)) {
    if (!value) continue;
    lines.push(`${key}=${value}`);
  }

  return lines.join('\n');
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return undefined;
}

export const alertsService = {
  get enabled(): boolean {
    return config.alerts.enabled && Boolean(config.alerts.slackWebhookUrl);
  },

  async notify(input: AlertInput): Promise<void> {
    if (!this.enabled) return;

    const dedupeKey = input.dedupeKey || `${input.source}:${input.title}`;
    if (!shouldSendAlert(dedupeKey)) {
      return;
    }

    try {
      const message = buildMessage(input);
      const response = await fetch(config.alerts.slackWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'error',
            message: 'Failed to send Slack alert',
            status: response.status,
            response_body: trimToMax(body, 400),
          })
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          message: 'Slack alert send failed',
          error: serializeError(error),
        })
      );
    }
  },

  async notifyFromLog(logPayload: Record<string, unknown>): Promise<void> {
    const message = asString(logPayload.message) || 'Application error';
    const requestId = asString(logPayload.request_id) || '';
    const httpPath = asString(logPayload.http_path) || '';
    const callSid = asString(logPayload.twilio_call_sid) || '';
    const streamSid = asString(logPayload.stream_sid) || '';

    const details: Record<string, unknown> = {};
    if (config.alerts.includeFullPayload) {
      details.log_payload = logPayload;
    } else {
      details.request_id = logPayload.request_id;
      details.http_path = logPayload.http_path;
      details.twilio_call_sid = logPayload.twilio_call_sid;
      details.stream_sid = logPayload.stream_sid;
      details.call_status = logPayload.call_status;
    }

    const dedupeKey = requestId
      ? `log_error:req:${requestId}`
      : `log_error:${message}:${httpPath}:${callSid}:${streamSid}`;

    await this.notify({
      title: message,
      source: 'app.log_error',
      dedupeKey,
      details,
    });
  },
};
