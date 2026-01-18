import dotenv from 'dotenv';

dotenv.config();

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
