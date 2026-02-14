import { Router, Request, Response } from 'express';
import { twilioService } from '../services/twilioService';
import { n8nService } from '../services/n8nService';
import { sessionManager } from '../services/sessionManager';
import { completionTracker } from '../services/completionTracker';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import {
  OutboundCallRequest,
  OutboundCallResponse,
  ErrorResponse,
  N8nConfigRequest,
  N8nCompletionWebhook,
  CallConfig,
} from '../types';

const router: Router = Router();

function normalizeStaticMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const TERMINAL_CALL_STATUSES = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

function isRequestSecure(req: Request): boolean {
  if (req.secure) {
    return true;
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  if (Array.isArray(forwardedProto)) {
    return forwardedProto.some((proto) => proto.trim() === 'https');
  }

  if (typeof forwardedProto === 'string') {
    return forwardedProto.split(',').some((proto) => proto.trim() === 'https');
  }

  return false;
}

function getHost(req: Request): string {
  const host = req.headers.host;
  if (!host) {
    throw new Error('Missing host header');
  }

  return host;
}

function getHttpBaseUrl(req: Request): string {
  const protocol = isRequestSecure(req) ? 'https' : 'http';
  return `${protocol}://${getHost(req)}`;
}

function getWebsocketUrl(req: Request): string {
  const protocol = isRequestSecure(req) ? 'wss' : 'ws';
  return `${protocol}://${getHost(req)}/media-stream`;
}

function normalizeCallStatus(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

async function sendCompletionFromSession(
  callSid: string,
  status: string,
  fallbackFrom?: string,
  fallbackTo?: string
): Promise<void> {
  logger.addContext({
    twilio_call_sid: callSid,
    call_status: status,
  });

  if (!completionTracker.begin(callSid)) {
    return;
  }

  try {
    const session = sessionManager.getSession(callSid);
    if (!session) {
      logger.warn('Completion fallback skipped; session not found', { callSid, status });
      return;
    }

    const endedSession = sessionManager.endSession(callSid) || session;
    const duration = endedSession.endTime && endedSession.startTime
      ? Math.floor((endedSession.endTime.getTime() - endedSession.startTime.getTime()) / 1000)
      : undefined;

    const completionData: N8nCompletionWebhook = {
      event: 'call.completed',
      twilio_call_sid: callSid,
      openai_conversation_id: endedSession.openaiConversationId || 'unknown',
      from: endedSession.from || fallbackFrom,
      to: endedSession.to || fallbackTo,
      direction: endedSession.direction,
      duration,
      status,
      metadata: endedSession.config.metadata,
      timestamp: new Date().toISOString(),
    };

    if (endedSession.tokenUsage) {
      completionData.token_usage = endedSession.tokenUsage;
    }

    const sent = await n8nService.sendCompletionWebhook(
      endedSession.config.webhook_url,
      completionData
    );

    if (sent) {
      completionTracker.complete(callSid);
      sessionManager.removeSession(callSid);
    } else {
      logger.warn('Completion fallback webhook failed; retry may happen on later events', { callSid, status });
    }
  } finally {
    completionTracker.endAttempt(callSid);
  }
}

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
    let prefetchedConfig: CallConfig | null = null;

    logger.addContext({
      twilio_call_sid: callSid,
      from,
      to,
      direction: 'inbound',
    });

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
        const prefetch = n8nService.fetchConfigOnce(n8nWebhookUrl, configRequest);
        prefetchedConfig = await Promise.race([
          prefetch,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);

        if (prefetchedConfig) {
          const staticMessage = normalizeStaticMessage(prefetchedConfig.static_message);

          if (staticMessage) {
            logger.info('Inbound call configured for static message; skipping AI session', {
              callSid,
            });
          } else {
            sessionManager.createSession(
              callSid,
              prefetchedConfig,
              'inbound',
              from,
              to
            );
            logger.info('Prefetched inbound config and created session', { callSid });
          }
        } else {
          logger.warn('n8n prefetch timed out; proceeding to answer and fetch on WS connect', { callSid });
        }
      } catch (e) {
        logger.warn('n8n prefetch failed; proceeding without blocking answer', { callSid, error: e });
      }
    }

    const inboundStaticMessage = normalizeStaticMessage(prefetchedConfig?.static_message);
    if (inboundStaticMessage) {
      const twiml = twilioService.generateStaticMessageTwiML(inboundStaticMessage);
      res.type('text/xml');
      return res.send(twiml);
    }

    const websocketUrl = getWebsocketUrl(req);
    const streamStatusCallbackUrl = `${getHttpBaseUrl(req)}/twilio/stream-status`;

    // Generate TwiML with custom parameters (Twilio passes these in the 'start' event)
    const twiml = twilioService.generateInboundTwiML(
      websocketUrl,
      callSid,
      from,
      to,
      streamStatusCallbackUrl
    );

    res.type('text/xml');
    return res.send(twiml);
  } catch (error) {
    logger.error('Error handling incoming call', error);
    return res.status(500).send('Internal Server Error');
  }
});

/**
 * Outbound call endpoint
 */
router.post('/outbound-call', async (req: Request, res: Response) => {
  try {
    const callRequest: OutboundCallRequest = req.body;
    const staticMessage = normalizeStaticMessage(callRequest.static_message);

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

    logger.addContext({
      to: callRequest.to,
      from: callRequest.from,
      direction: 'outbound',
    });

    let tempId = '';
    let websocketUrl = '';
    const baseUrl = getHttpBaseUrl(req);
    const callStatusCallbackUrl = `${baseUrl}/twilio/call-status`;
    let streamStatusCallbackUrl = '';

    if (!staticMessage) {
      streamStatusCallbackUrl = `${baseUrl}/twilio/stream-status`;

      // Generate a temporary identifier for this outbound call
      tempId = `outbound-${Date.now()}`;
      websocketUrl = getWebsocketUrl(req);

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
        static_message: staticMessage,
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
    }

    // Initiate the call
    const { callSid, status } = await twilioService.makeOutboundCall(
      callRequest.to,
      callRequest.from,
      websocketUrl,
      tempId,
      staticMessage,
      callStatusCallbackUrl,
      streamStatusCallbackUrl
    );

    logger.addContext({ twilio_call_sid: callSid });

    if (staticMessage) {
      sessionManager.createSession(
        callSid,
        {
          voice: callRequest.voice,
          model: callRequest.model,
          instructions: callRequest.instructions,
          temperature: callRequest.temperature,
          modalities: callRequest.modalities,
          turn_detection: callRequest.turn_detection,
          tools: callRequest.tools,
          metadata: callRequest.metadata,
          static_message: staticMessage,
          webhook_url: callRequest.webhook_url,
        },
        'outbound',
        callRequest.from || config.twilio.phoneNumber,
        callRequest.to
      );
    } else if (tempId) {
      const tempSession = sessionManager.getSession(tempId);
      if (tempSession) {
        sessionManager.createSession(
          callSid,
          tempSession.config,
          tempSession.direction,
          tempSession.from,
          tempSession.to
        );
      } else {
        logger.warn('Could not map outbound temp session to callSid', { tempId, callSid });
      }
    }

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

/**
 * Twilio call status callback (outbound fallback path).
 */
router.post('/twilio/call-status', async (req: Request, res: Response) => {
  try {
    const callSid = typeof req.body.CallSid === 'string' ? req.body.CallSid : '';
    const callStatus = normalizeCallStatus(req.body.CallStatus);

    logger.addContext({
      twilio_call_sid: callSid,
      call_status: callStatus,
    });

    logger.info('Twilio call status callback received', {
      callSid,
      callStatus,
      from: req.body.From,
      to: req.body.To,
      duration: req.body.CallDuration,
    });

    if (!callSid || !callStatus || !TERMINAL_CALL_STATUSES.has(callStatus)) {
      return res.sendStatus(204);
    }

    if (callStatus === 'completed') {
      const session = sessionManager.getSession(callSid);
      if (session?.openaiConversationId) {
        // Media-stream teardown path carries richer completion data (tool calls/tokens).
        return res.sendStatus(204);
      }
    }

    await sendCompletionFromSession(callSid, callStatus, req.body.From, req.body.To);
    return res.sendStatus(204);
  } catch (error) {
    logger.error('Error handling Twilio call status callback', error);
    return res.sendStatus(500);
  }
});

/**
 * Twilio Media Stream status callback.
 */
router.post('/twilio/stream-status', async (req: Request, res: Response) => {
  try {
    const callSid = typeof req.body.CallSid === 'string' ? req.body.CallSid : '';
    const streamSid = typeof req.body.StreamSid === 'string' ? req.body.StreamSid : '';
    const streamEvent = typeof req.body.StreamEvent === 'string'
      ? req.body.StreamEvent.toLowerCase()
      : '';
    const streamError = typeof req.body.StreamError === 'string' ? req.body.StreamError : undefined;

    logger.addContext({
      twilio_call_sid: callSid,
      stream_sid: streamSid,
      stream_event: streamEvent,
    });

    logger.info('Twilio stream status callback received', {
      callSid,
      streamSid,
      streamEvent,
      streamError,
    });

    if (!callSid || streamEvent !== 'stream-error') {
      return res.sendStatus(204);
    }

    await sendCompletionFromSession(callSid, 'stream-error', req.body.From, req.body.To);
    return res.sendStatus(204);
  } catch (error) {
    logger.error('Error handling Twilio stream status callback', error);
    return res.sendStatus(500);
  }
});

export default router;
