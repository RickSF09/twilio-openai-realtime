import express from 'express';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './utils/config';
import { logger } from './utils/logger';
import routes from './routes';
import { mediaStreamHandler } from './services/mediaStreamHandler';
import { n8nService } from './services/n8nService';
import { sessionManager } from './services/sessionManager';
import { N8nConfigRequest } from './types';

// Create Express app
const app = express();
app.set('trust proxy', true);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
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

function summarizeBody(body: unknown): Record<string, unknown> {
  const bodyRecord = asRecord(body);
  if (!bodyRecord) {
    return {
      body_type: body === null ? 'null' : typeof body,
    };
  }

  const keys = Object.keys(bodyRecord);
  return {
    body_keys: keys.slice(0, 20),
    body_key_count: keys.length,
  };
}

function extractRequestContext(req: express.Request): Record<string, unknown> {
  const body = asRecord(req.body);
  const query = asRecord(req.query);

  return {
    twilio_call_sid:
      asString(body?.CallSid)
      ?? asString(body?.callSid)
      ?? asString(body?.twilio_call_sid)
      ?? asString(query?.callSid),
    stream_sid:
      asString(body?.StreamSid)
      ?? asString(body?.streamSid)
      ?? asString(body?.stream_sid),
    direction:
      asString(body?.Direction)
      ?? asString(body?.direction)
      ?? asString(query?.direction),
    temp_id:
      asString(body?.tempId)
      ?? asString(body?.temp_id)
      ?? asString(query?.tempId),
  };
}

// Request logging middleware
app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  const incomingRequestId = asString(req.headers['x-request-id']);
  const requestId = incomingRequestId || randomUUID();

  res.setHeader('x-request-id', requestId);

  const requestContext = {
    request_id: requestId,
    http_method: req.method,
    http_path: req.path,
    ...extractRequestContext(req),
  };

  logger.runWithContext(requestContext, () => {
    logger.info('HTTP request started', {
      ip: req.ip,
      user_agent: req.headers['user-agent'],
      query: req.query,
      ...summarizeBody(req.body),
    });
  });

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.runWithContext(requestContext, () => {
      const payload = {
        status_code: res.statusCode,
        duration_ms: Number(durationMs.toFixed(2)),
      };

      if (res.statusCode >= 500) {
        logger.error('HTTP request completed with server error', payload);
        return;
      }

      if (res.statusCode >= 400) {
        logger.warn('HTTP request completed with client error', payload);
        return;
      }

      logger.info('HTTP request completed', payload);
    });
  });

  next();
});

// Routes
app.use('/', routes);

// Final request error handler (captures uncaught route/middleware errors)
app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestContext = {
    request_id: asString(req.headers['x-request-id']) || randomUUID(),
    http_method: req.method,
    http_path: req.path,
    ...extractRequestContext(req),
  };

  logger.runWithContext(requestContext, () => {
    logger.error('Unhandled request error', error);
  });

  if (res.headersSent) {
    return;
  }

  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

// Create HTTP server
const server = createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ 
  server,
  path: '/media-stream',
});

// WebSocket connection handler
wss.on('connection', async (ws: WebSocket, req) => {
  const connectionId = randomUUID();
  const requestId = asString(req.headers['x-request-id']) || connectionId;

  await logger.runWithContext(
    {
      request_id: requestId,
      connection_id: connectionId,
      transport: 'websocket',
    },
    async () => {
      logger.info('WebSocket connection established', {
        url: req.url,
        user_agent: req.headers['user-agent'],
        forwarded_for: req.headers['x-forwarded-for'],
      });

      try {
        // Parse query parameters
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const params = url.searchParams;

        const callSid = params.get('callSid');
        const tempId = params.get('tempId');
        const direction = params.get('direction') as 'inbound' | 'outbound' | null;
        const from = params.get('from');
        const to = params.get('to');

        let actualCallSid: string;
        let callDirection: 'inbound' | 'outbound';
        let callConfig;

        if (tempId && direction === 'outbound') {
          logger.addContext({ temp_id: tempId, direction: 'outbound' });

          // Outbound call - get config from session manager
          callDirection = 'outbound';

          // Wait for actual CallSid from Twilio 'start' event
          // For now, use tempId and update later
          const tempSession = sessionManager.getSession(tempId);

          if (!tempSession) {
            logger.error('Temporary session not found for outbound call', { tempId });
            ws.close(1008, 'Session not found');
            return;
          }

          callConfig = tempSession.config;
          actualCallSid = tempId; // Will be updated when we receive 'start' event

          // We'll handle the actual CallSid update in the media stream handler
          logger.info('Outbound call WebSocket connected', { tempId });
        } else if (callSid && from && to) {
          logger.addContext({
            twilio_call_sid: callSid,
            direction: 'inbound',
          });

          // Inbound call
          callDirection = 'inbound';
          actualCallSid = callSid;

          // Prefer prefetched session config if available (created in /incoming-call)
          const existingSession = sessionManager.getSession(callSid);
          if (existingSession) {
            callConfig = existingSession.config;
            logger.info('Using prefetched inbound config from session', { callSid });
          } else {
            // Fallback: fetch configuration from n8n webhook
            const n8nWebhookUrl = config.n8n.defaultWebhookUrl;

            if (n8nWebhookUrl) {
              const configRequest: N8nConfigRequest = {
                event: 'call.started',
                twilio_call_sid: callSid,
                from: decodeURIComponent(from),
                to: decodeURIComponent(to),
                timestamp: new Date().toISOString(),
              };

              callConfig = await n8nService.fetchConfigOnce(n8nWebhookUrl, configRequest);
            } else {
              // Use default config if no webhook URL configured
              callConfig = n8nService.getDefaultConfig('');
              logger.warn('No default n8n webhook URL configured, using default config');
            }
          }

          logger.info('Inbound call WebSocket connected', { callSid, from, to });
        } else {
          // Allow connection without query params; we'll initialize on Twilio 'start' using customParameters
          logger.warn('WebSocket connected without expected query parameters; deferring initialization');
          await mediaStreamHandler.handleConnectionLazyInit(ws);
          return;
        }

        // Handle the media stream
        await mediaStreamHandler.handleConnection(
          ws,
          callConfig,
          actualCallSid,
          callDirection,
          from ? decodeURIComponent(from) : undefined,
          to ? decodeURIComponent(to) : undefined
        );
      } catch (error) {
        logger.error('Error handling WebSocket connection', error);
        ws.close(1011, 'Internal server error');
      }
    }
  );
});

wss.on('error', (error) => {
  logger.error('WebSocket server error', error);
});

server.on('error', (error) => {
  logger.error('HTTP server error', error);
});

const heartbeatTimer = config.alerts.heartbeatIntervalSeconds > 0
  ? setInterval(() => {
      logger.info('Service heartbeat', {
        event_type: 'service_heartbeat',
        service: config.alerts.serviceName,
      });
    }, config.alerts.heartbeatIntervalSeconds * 1_000)
  : null;

// Start server
server.listen(config.server.port, () => {
  logger.info(`Server started on port ${config.server.port}`, {
    nodeEnv: config.server.nodeEnv,
    port: config.server.port,
  });
  logger.info('Endpoints available:');
  logger.info(`  - GET  /`);
  logger.info(`  - POST /incoming-call`);
  logger.info(`  - POST /outbound-call`);
  logger.info(`  - WS   /media-stream`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
});
