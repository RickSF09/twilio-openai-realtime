import dotenv from 'dotenv';

dotenv.config();

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseNonNegativeInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return defaultValue;
  }

  return parsed;
}

function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return defaultValue;
  }

  return parsed;
}

function parseSeverity(value: string | undefined): 'P1' | 'P2' | 'P3' {
  if (!value) {
    return 'P2';
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === 'P1' || normalized === 'P2' || normalized === 'P3') {
    return normalized;
  }

  return 'P2';
}

export const config = {
  // Twilio
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
  },
  
  // OpenAI
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
  },
  
  // N8N
  n8n: {
    webhookAuth: process.env.N8N_WEBHOOK_AUTH || '',
    defaultWebhookUrl: process.env.DEFAULT_N8N_WEBHOOK_URL || '',
    requestTimeoutMs: parsePositiveInt(process.env.N8N_REQUEST_TIMEOUT_MS, 35_000),
    inboundPrefetchTimeoutMs: Math.min(
      parsePositiveInt(process.env.N8N_INBOUND_PREFETCH_TIMEOUT_MS, 14_000),
      14_000
    ),
  },
  
  // Server
  server: {
    port: parseInt(process.env.PORT || '5050', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
  },
  
  // Defaults
  defaults: {
    voice: process.env.DEFAULT_VOICE || 'alloy',
    temperature: parseFloat(process.env.DEFAULT_TEMPERATURE || '0.8'),
    model: process.env.DEFAULT_MODEL || 'gpt-realtime',
  },

  // Realtime session lifecycle
  realtime: {
    sessionLimitSeconds: parsePositiveInt(process.env.REALTIME_SESSION_LIMIT_SECONDS, 3_600),
    graceWarningBeforeEndSeconds: parseNonNegativeInt(
      process.env.REALTIME_GRACE_WARNING_BEFORE_END_SECONDS,
      300
    ),
  },

  // Alerting
  alerts: {
    enabled: parseBoolean(process.env.ALERTS_ENABLED, true),
    slackWebhookUrl: process.env.ALERTS_SLACK_WEBHOOK_URL || '',
    defaultSeverity: parseSeverity(process.env.ALERTS_DEFAULT_SEVERITY),
    minIntervalSeconds: parseNonNegativeInt(process.env.ALERTS_MIN_INTERVAL_SECONDS, 600),
    serviceName: process.env.ALERTS_SERVICE_NAME || 'twilio-openai-realtime',
    includeFullPayload: parseBoolean(process.env.ALERTS_INCLUDE_FULL_PAYLOAD, true),
    heartbeatIntervalSeconds: parseNonNegativeInt(process.env.HEARTBEAT_INTERVAL_SECONDS, 300),
  },

  // Readiness
  readiness: {
    forceError: process.env.READINESS_FORCE_ERROR || '',
  },
};

export function validateConfig(): void {
  const required = [
    { key: 'TWILIO_ACCOUNT_SID', value: config.twilio.accountSid },
    { key: 'TWILIO_AUTH_TOKEN', value: config.twilio.authToken },
    { key: 'TWILIO_PHONE_NUMBER', value: config.twilio.phoneNumber },
    { key: 'OPENAI_API_KEY', value: config.openai.apiKey },
    { key: 'N8N_WEBHOOK_AUTH', value: config.n8n.webhookAuth },
  ];

  const missing = required.filter(({ value }) => !value);

  if (missing.length > 0) {
    const missingKeys = missing.map(({ key }) => key).join(', ');
    throw new Error(
      `Missing required environment variables: ${missingKeys}. ` +
      `Please check your .env file.`
    );
  }
}

// Run validation immediately on import
validateConfig();
