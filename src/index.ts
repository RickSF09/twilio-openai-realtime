import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config, validateConfig } from './utils/config';
import { logger } from './utils/logger';
import routes from './routes';
import { mediaStreamHandler } from './services/mediaStreamHandler';
import { n8nService } from './services/n8nService';
import { sessionManager } from './services/sessionManager';
import { N8nConfigRequest } from './types';

// Validate configuration
try {
  validateConfig();
  logger.info('Configuration validated successfully');
} catch (error) {
  logger.error('Configuration validation failed', error);
  process.exit(1);
}

// Create Express app
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, _res, next) => {
  const headers = { ...req.headers };

  if (headers.authorization) {
    headers.authorization = '[REDACTED]';
  }

  logger.info(`${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    userAgent: req.headers['user-agent'],
    query: req.query,
    headers,
    body: req.body,
  });

  next();
});

// Routes
app.use('/', routes);

// Create HTTP server
const server = createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ 
  server,
  path: '/media-stream',
});

// WebSocket connection handler
wss.on('connection', async (ws: WebSocket, req) => {
  logger.info('WebSocket connection established', { 
    url: req.url,
    headers: req.headers 
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

          callConfig = await n8nService.fetchConfig(n8nWebhookUrl, configRequest);
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
});

wss.on('error', (error) => {
  logger.error('WebSocket server error', error);
});

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
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
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
