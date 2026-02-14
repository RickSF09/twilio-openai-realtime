import WebSocket from 'ws';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { CallConfig, OpenAISessionConfig, ToolConfig } from '../types';

const HANGUP_CALL_TOOL: ToolConfig = {
  type: 'function',
  name: 'hangup_call',
  description: 'End the active call when the caller or agent indicates the conversation is finished Or immediatly when you reached the voicemail',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};

export class OpenAIRealtimeService {
  /**
   * Create WebSocket connection to OpenAI Realtime API
   */
  createConnection(_temperature?: number): WebSocket {
    // Note: temperature parameter is kept for backwards compatibility but not used
    const url = `wss://api.openai.com/v1/realtime?model=gpt-realtime`;
    
    logger.info('Creating OpenAI Realtime WebSocket connection');

    const ws = new WebSocket(url, {
      headers: {
        'Authorization': `Bearer ${config.openai.apiKey}`,
      },
      perMessageDeflate: false,
    });

    return ws;
  }

  /**
   * Build session configuration for OpenAI
   */
  buildSessionConfig(callConfig: CallConfig): OpenAISessionConfig {
    // Normalize requested modalities to GA-compliant output_modalities
    const requestedModalities = callConfig.modalities && callConfig.modalities.length > 0
      ? callConfig.modalities
      : ['audio'];

    const outputModalities = (requestedModalities.includes('audio') && requestedModalities.includes('text'))
      ? (logger.debug('Both audio and text requested; coercing output_modalities to ["audio"]'), ['audio'])
      : requestedModalities;

    const sessionConfig: OpenAISessionConfig = {
      type: 'realtime',
      output_modalities: outputModalities,
      audio: {
        input: {
          format: {
            type: 'audio/pcmu', // μ-law for Twilio
          },
          noise_reduction: {
            type: 'far_field',
          },
          // Explicitly disable model-side transcription; we transcribe in n8n post-call
          transcription: null,
          turn_detection: callConfig.turn_detection || {
            type: 'semantic_vad',
            eagerness: 'high',
          },
        },
        output: {
          format: {
            type: 'audio/pcmu', // μ-law for Twilio
          },
          voice: callConfig.voice || config.defaults.voice,
        },
      },
    };

    // Add optional fields
    if (callConfig.instructions) {
      sessionConfig.instructions = callConfig.instructions;
    }

    // Note: OpenAI Realtime API does not support temperature parameter in session config
    // Temperature is removed as it causes "unknown_parameter" errors

    const tools: ToolConfig[] = [];

    if (callConfig.tools && callConfig.tools.length > 0) {
      tools.push(...callConfig.tools);
    }

    const hasHangupTool = tools.some(
      (tool) => tool.type === 'function' && tool.name === HANGUP_CALL_TOOL.name
    );

    if (!hasHangupTool) {
      tools.push(HANGUP_CALL_TOOL);
    }

    if (tools.length > 0) {
      sessionConfig.tools = tools;
    }

    // Add truncation strategy
    sessionConfig.truncation = {
      type: 'retention_ratio',
      retention_ratio: 0.6,
    };

    return sessionConfig;
  }

  /**
   * Send session update to OpenAI
   */
  async sendSessionUpdate(
    ws: WebSocket,
    callConfig: CallConfig
  ): Promise<void> {
    const sessionConfig = this.buildSessionConfig(callConfig);
    
    const sessionUpdate = {
      type: 'session.update',
      session: sessionConfig,
    };

    logger.debug('Sending session.update to OpenAI', sessionConfig);

    return new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(sessionUpdate), (error) => {
          if (error) {
            logger.error('Failed to send session.update', error);
            reject(error);
          } else {
            logger.info('Session update sent to OpenAI');
            resolve();
          }
        });
      } else {
        reject(new Error('WebSocket is not open'));
      }
    });
  }

  /**
   * Send audio data to OpenAI
   */
  sendAudio(ws: WebSocket, audioPayload: string): void {
    if (ws.readyState === WebSocket.OPEN) {
      const audioAppend = {
        type: 'input_audio_buffer.append',
        audio: audioPayload,
      };
      ws.send(JSON.stringify(audioAppend));
    }
  }

  /**
   * Handle interruption (truncate current response)
   */
  async handleInterruption(
    ws: WebSocket,
    itemId: string,
    elapsedTimeMs: number
  ): Promise<void> {
    const truncateEvent = {
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: 0,
      audio_end_ms: elapsedTimeMs,
    };

    logger.debug('Sending truncate event', { itemId, elapsedTimeMs });

    return new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(truncateEvent), (error) => {
          if (error) {
            logger.error('Failed to send truncate event', error);
            reject(error);
          } else {
            resolve();
          }
        });
      } else {
        reject(new Error('WebSocket is not open'));
      }
    });
  }

  /**
   * Clear the input audio buffer
   * Used to discard any buffered user audio (e.g., soft acknowledgments during AI speech)
   */
  clearInputAudioBuffer(ws: WebSocket): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const clearEvent = {
      type: 'input_audio_buffer.clear',
    };

    logger.debug('Clearing input audio buffer');
    ws.send(JSON.stringify(clearEvent));
  }
}

export const openaiService = new OpenAIRealtimeService();
