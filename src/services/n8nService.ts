import axios from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { CallConfig, N8nConfigRequest, N8nCompletionWebhook } from '../types';

export class N8nService {
  /**
   * Fetch call configuration from n8n webhook
   */
  async fetchConfig(
    webhookUrl: string,
    callData: N8nConfigRequest
  ): Promise<CallConfig> {
    try {
      logger.info('Fetching configuration from n8n webhook', { webhookUrl });

      const response = await axios.post<CallConfig>(webhookUrl, callData, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': config.n8n.webhookAuth,
        },
        timeout: 20000, // Allow up to 20 seconds for n8n to respond
      });

      logger.info('Configuration fetched successfully from n8n');
      return response.data;
    } catch (error) {
      logger.error('Failed to fetch configuration from n8n', error);
      
      // Return minimal config with webhook_url
      return {
        webhook_url: webhookUrl,
        voice: config.defaults.voice,
        model: config.defaults.model,
        temperature: config.defaults.temperature,
      };
    }
  }

  /**
   * Send call completion webhook to n8n
   */
  async sendCompletionWebhook(
    webhookUrl: string,
    data: N8nCompletionWebhook
  ): Promise<boolean> {
    try {
      logger.info('Sending completion webhook to n8n', { 
        webhookUrl,
        callSid: data.twilio_call_sid 
      });

      await axios.post(webhookUrl, data, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': config.n8n.webhookAuth,
        },
        timeout: 20000,
      });

      logger.info('Completion webhook sent successfully');
      return true;
    } catch (error) {
      logger.error('Failed to send completion webhook to n8n', error);
      // Don't throw - we don't want to crash if webhook fails
      return false;
    }
  }

  /**
   * Get default configuration
   */
  getDefaultConfig(webhookUrl: string): CallConfig {
    return {
      voice: config.defaults.voice,
      model: config.defaults.model,
      temperature: config.defaults.temperature,
      modalities: ['audio'],
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        silence_duration_ms: 500,
      },
      webhook_url: webhookUrl,
    };
  }
}

export const n8nService = new N8nService();
