import { Router, Request, Response } from 'express';
import { twilioService } from '../services/twilioService';
import { n8nService } from '../services/n8nService';
import { sessionManager } from '../services/sessionManager';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { OutboundCallRequest, OutboundCallResponse, ErrorResponse, N8nConfigRequest } from '../types';

const router: Router = Router();

/**
 * Health check endpoint
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'Twilio + OpenAI Realtime API Server',
    version: '1.0.0',
    activeSessions: sessionManager.getSessionCount(),
  });
});

/**
 * Incoming call webhook from Twilio
 */
router.post('/incoming-call', async (req: Request, res: Response) => {
  try {
    const callSid = req.body.CallSid;
    const from = req.body.From;
    const to = req.body.To;

    logger.info('Incoming call received', { callSid, from, to });

    // Prefetch n8n configuration before answering to avoid silence post-answer
    // Cap the wait time to avoid Twilio webhook timeout
    const n8nWebhookUrl = config.n8n.defaultWebhookUrl;
    if (n8nWebhookUrl && callSid && from && to) {
      try {
        const configRequest: N8nConfigRequest = {
          event: 'call.started',
          twilio_call_sid: callSid,
          from,
          to,
          timestamp: new Date().toISOString(),
        };

        const timeoutMs = 16000; // keep under Twilio's expected webhook response window
        const prefetch = n8nService.fetchConfig(n8nWebhookUrl, configRequest);
        const prefetchedConfig = await Promise.race([
          prefetch,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);

        if (prefetchedConfig) {
          sessionManager.createSession(
            callSid,
            prefetchedConfig,
            'inbound',
            from,
            to
          );
          logger.info('Prefetched inbound config and created session', { callSid });
        } else {
          logger.warn('n8n prefetch timed out; proceeding to answer and fetch on WS connect', { callSid });
        }
      } catch (e) {
        logger.warn('n8n prefetch failed; proceeding without blocking answer', { callSid, error: e });
      }
    }

    // Get the host from request
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' 
      ? 'wss' 
      : 'ws';
    const host = req.headers.host;
    const websocketUrl = `${protocol}://${host}/media-stream`;

    // Generate TwiML with custom parameters (Twilio passes these in the 'start' event)
    const twiml = twilioService.generateInboundTwiML(websocketUrl, callSid, from, to);

    // Start call recording (non-blocking)
    twilioService.startRecording(callSid).catch((err) => {
      logger.error('Failed to start recording for inbound call', err);
    });

    res.type('text/xml');
    res.send(twiml);
  } catch (error) {
    logger.error('Error handling incoming call', error);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * Outbound call endpoint
 */
router.post('/outbound-call', async (req: Request, res: Response) => {
  try {
    const callRequest: OutboundCallRequest = req.body;

    // Validate required fields
    if (!callRequest.to) {
      const errorResponse: ErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_REQUIRED_FIELD',
          message: 'Missing required field: to',
        },
      };
      return res.status(400).json(errorResponse);
    }

    if (!callRequest.webhook_url) {
      const errorResponse: ErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_REQUIRED_FIELD',
          message: 'Missing required field: webhook_url',
        },
      };
      return res.status(400).json(errorResponse);
    }

    logger.info('Outbound call request received', { 
      to: callRequest.to,
      from: callRequest.from 
    });

    // Get the host from request for WebSocket URL
    const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' 
      ? 'wss' 
      : 'ws';
    const host = req.headers.host;

    // Generate a temporary identifier for this outbound call
    const tempId = `outbound-${Date.now()}`;
    const websocketUrl = `${protocol}://${host}/media-stream?tempId=${tempId}&direction=outbound`;

    // Store the config temporarily (will be picked up by WebSocket handler)
    // We'll use the session manager for this
    const callConfig = {
      voice: callRequest.voice,
      model: callRequest.model,
      instructions: callRequest.instructions,
      temperature: callRequest.temperature,
      modalities: callRequest.modalities,
      turn_detection: callRequest.turn_detection,
      tools: callRequest.tools,
      metadata: callRequest.metadata,
      webhook_url: callRequest.webhook_url,
    };

    // Store config with tempId (will be replaced with actual CallSid)
    sessionManager.createSession(
      tempId,
      callConfig,
      'outbound',
      callRequest.from || config.twilio.phoneNumber,
      callRequest.to
    );

    // Initiate the call
    const { callSid, status } = await twilioService.makeOutboundCall(
      callRequest.to,
      callRequest.from,
      websocketUrl,
      tempId
    );

    const response: OutboundCallResponse = {
      success: true,
      twilio_call_sid: callSid,
      status,
      message: 'Outbound call initiated successfully',
    };

    return res.json(response);
  } catch (error) {
    logger.error('Error initiating outbound call', error);
    
    const errorResponse: ErrorResponse = {
      success: false,
      error: {
        code: 'TWILIO_ERROR',
        message: 'Failed to initiate outbound call',
        details: error instanceof Error ? error.message : String(error),
      },
    };
    
    return res.status(500).json(errorResponse);
  }
});

export default router;
