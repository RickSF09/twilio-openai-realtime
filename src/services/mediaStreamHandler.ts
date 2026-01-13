import WebSocket from 'ws';
import { performance } from 'node:perf_hooks';
import { logger } from '../utils/logger';
import { config } from '../utils/config';
import { openaiService } from './openaiService';
import { n8nService } from './n8nService';
import { sessionManager } from './sessionManager';
import { twilioService } from './twilioService';
import { 
  TwilioMediaEvent, 
  OpenAIRealtimeEvent, 
  CallConfig,
  N8nCompletionWebhook,
  ToolCallPayload,
  SessionTokenUsage,
  OpenAITokenUsageTotals,
  TokenUsageDetails,
  TokenUsageBreakdown,
} from '../types';

// Track calls that have already had completion processing to avoid duplicates
const completedCallSids = new Set<string>();

const TOKEN_DETAIL_KEYS: Array<keyof TokenUsageBreakdown> = [
  'text_tokens',
  'audio_tokens',
  'image_tokens',
  'cached_tokens',
];

const CACHED_TOKEN_DETAIL_KEYS: Array<keyof TokenUsageBreakdown> = [
  'text_tokens',
  'audio_tokens',
  'image_tokens',
];

class TwilioAudioPlayout {
  private buffer: Buffer = Buffer.alloc(0);
  private playoutTimer: NodeJS.Timeout | null = null;
  private pendingDrain = false;
  private lastMarkSent = 0;
  private disposed = false;
  private streamingStarted = false;
  private nextSendTime: number | null = null;

  private static readonly FRAME_DURATION_MS = 20;
  private static readonly FRAME_SIZE_BYTES = 160;
  private static readonly INITIAL_FRAMES = 3;
  private static readonly MARK_INTERVAL_MS = 200;
  private static readonly MAX_PENDING_MARKS = 3;

  constructor(
    private readonly ws: WebSocket,
    private readonly streamSidGetter: () => string | null,
    private readonly markQueue: string[],
  ) {}

  enqueue(base64Payload: string): void {
    if (this.disposed) {
      return;
    }

    const chunk = Buffer.from(base64Payload, 'base64');
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    this.pendingDrain = false;
    const shouldForceStart = !this.streamingStarted;
    this.startTimerIfReady(shouldForceStart);
  }

  notifyResponseFinished(): void {
    if (this.disposed) {
      return;
    }

    this.pendingDrain = true;
    this.startTimerIfReady(true);
    this.stopIfDrained();
  }

  reset(): void {
    if (this.disposed) {
      return;
    }

    this.buffer = Buffer.alloc(0);
    this.pendingDrain = false;
    this.streamingStarted = false;
    this.clearTimer();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.clearTimer();
    this.buffer = Buffer.alloc(0);
    this.streamingStarted = false;
  }

  getBufferLength(): number {
    return this.buffer.length;
  }

  private startTimerIfReady(force: boolean): void {
    if (this.disposed || this.playoutTimer) {
      return;
    }

    const requiredBytes = TwilioAudioPlayout.FRAME_SIZE_BYTES * TwilioAudioPlayout.INITIAL_FRAMES;
    if (!force && !this.streamingStarted && this.buffer.length < requiredBytes) {
      return;
    }

    this.streamingStarted = true;
    this.nextSendTime = performance.now();
    this.scheduleNextFrame();
  }

  private scheduleNextFrame(): void {
    if (this.disposed) {
      return;
    }

    const now = performance.now();
    const targetTime =
      (this.nextSendTime ?? now) + TwilioAudioPlayout.FRAME_DURATION_MS;
    
    // Track drift if we have a previous target
    if (this.nextSendTime !== null) {
      const drift = now - this.nextSendTime;
      if (drift > 10) { // Log significant drift (>10ms)
        logger.warn('Playout timer drift detected', { drift, targetTime: this.nextSendTime, actualTime: now });
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/887d4abd-dc84-4c10-b9de-e28c1a2adb42',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'mediaStreamHandler.ts:125',message:'TIMER_DRIFT_DETECTED',data:{drift,targetTime:this.nextSendTime,actualTime:now},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
        // #endregion
      }
    }

    this.nextSendTime = targetTime;
    const delay = Math.max(0, targetTime - now);

    this.playoutTimer = setTimeout(() => {
      this.playoutTimer = null;
      const sentFrame = this.flushFrame();

      if (this.disposed || this.playoutTimer) {
        return;
      }

      if (!sentFrame && !this.pendingDrain) {
        this.nextSendTime = null;
        return;
      }

      if (this.pendingDrain && this.buffer.length === 0) {
        this.stopIfDrained();
        return;
      }

      this.scheduleNextFrame();
    }, delay);
  }

  private flushFrame(): boolean {
    if (this.disposed) {
      this.clearTimer();
      return false;
    }

    if (this.ws.readyState !== WebSocket.OPEN) {
      this.clearTimer();
      return false;
    }

    const streamSid = this.streamSidGetter();
    if (!streamSid) {
      return false;
    }

    let frame: Buffer | null = null;

    if (this.buffer.length >= TwilioAudioPlayout.FRAME_SIZE_BYTES) {
      frame = this.buffer.subarray(0, TwilioAudioPlayout.FRAME_SIZE_BYTES);
      this.buffer = this.buffer.subarray(TwilioAudioPlayout.FRAME_SIZE_BYTES);
    } else if (this.pendingDrain && this.buffer.length > 0) {
      frame = Buffer.alloc(TwilioAudioPlayout.FRAME_SIZE_BYTES, 0xff);
      this.buffer.copy(frame, 0);
      this.buffer = Buffer.alloc(0);
    } else {
      if (this.pendingDrain) {
        this.stopIfDrained();
      }
      return false;
    }

    const payload = frame.toString('base64');
    this.ws.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload },
    }));
    this.maybeSendMark(streamSid);

    if (this.pendingDrain) {
      this.stopIfDrained();
    }

    return true;
  }

  private maybeSendMark(streamSid: string): void {
    const now = Date.now();
    if (now - this.lastMarkSent < TwilioAudioPlayout.MARK_INTERVAL_MS) {
      return;
    }

    if (this.markQueue.length >= TwilioAudioPlayout.MAX_PENDING_MARKS) {
      return;
    }

    this.lastMarkSent = now;
    void sendMark(this.ws, streamSid, this.markQueue);
  }

  private stopIfDrained(): void {
    if (this.pendingDrain && this.buffer.length === 0) {
      this.pendingDrain = false;
      this.streamingStarted = false;
      this.clearTimer();
    }
  }

  private clearTimer(): void {
    if (this.playoutTimer) {
      clearTimeout(this.playoutTimer);
      this.playoutTimer = null;
    }
    this.nextSendTime = null;
  }
}

type UsageCategory = 'responses' | 'transcriptions';

interface FunctionCallState {
  name?: string;
  arguments: string;
  callId?: string;
  responseId?: string;
  toolCallId?: string;
  toolType?: 'function' | 'mcp';
  input?: string;
  output?: string;
}

interface FunctionCallContext {
  openaiWs: WebSocket;
  twilioWs: WebSocket;
  twilioCallSid: string;
  callConfig: CallConfig;
  direction: 'inbound' | 'outbound';
  from?: string;
  to?: string;
  executedFunctionCalls: ToolCallPayload[];
}

function mergeBreakdown(
  existing: TokenUsageBreakdown | undefined,
  incoming: Record<string, any> | undefined,
  includeCachedTokens: boolean
): TokenUsageBreakdown | undefined {
  if (!incoming || typeof incoming !== 'object') {
    return existing;
  }

  let mutated = false;
  const result: TokenUsageBreakdown = { ...(existing ?? {}) };
  const keys = includeCachedTokens ? TOKEN_DETAIL_KEYS : CACHED_TOKEN_DETAIL_KEYS;

  for (const key of keys) {
    const value = incoming[key];
    if (typeof value === 'number' && !Number.isNaN(value)) {
      result[key] = (result[key] ?? 0) + value;
      mutated = true;
    }
  }

  return mutated || existing ? result : undefined;
}

function mergeTokenDetails(
  existing: TokenUsageDetails | undefined,
  incoming: Record<string, any> | undefined
): TokenUsageDetails | undefined {
  if (!incoming || typeof incoming !== 'object') {
    return existing;
  }

  let mutated = false;
  const result: TokenUsageDetails = { ...(existing ?? {}) };

  for (const key of TOKEN_DETAIL_KEYS) {
    const value = incoming[key];
    if (typeof value === 'number' && !Number.isNaN(value)) {
      result[key] = (result[key] ?? 0) + value;
      mutated = true;
    }
  }

  if (incoming.cached_tokens_details) {
    const merged = mergeBreakdown(
      result.cached_tokens_details,
      incoming.cached_tokens_details,
      false
    );
    if (merged) {
      result.cached_tokens_details = merged;
      mutated = true;
    }
  }

  return mutated || existing ? result : undefined;
}

function mergeUsageTotals(
  existing: OpenAITokenUsageTotals | undefined,
  usage: Record<string, any>
): OpenAITokenUsageTotals {
  const totalTokens = typeof usage.total_tokens === 'number' ? usage.total_tokens : 0;
  const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

  return {
    total_tokens: (existing?.total_tokens ?? 0) + totalTokens,
    input_tokens: (existing?.input_tokens ?? 0) + inputTokens,
    output_tokens: (existing?.output_tokens ?? 0) + outputTokens,
    event_count: (existing?.event_count ?? 0) + 1,
    input_token_details: mergeTokenDetails(existing?.input_token_details, usage.input_token_details),
    output_token_details: mergeTokenDetails(existing?.output_token_details, usage.output_token_details),
  };
}

function recordTokenUsage(
  twilioCallSid: string,
  usage: Record<string, any> | undefined,
  category: UsageCategory
): void {
  if (!usage || typeof usage !== 'object') {
    return;
  }

  const hasTokenValues =
    typeof usage.total_tokens === 'number' ||
    typeof usage.input_tokens === 'number' ||
    typeof usage.output_tokens === 'number';

  if (!hasTokenValues) {
    return;
  }

  const session = sessionManager.getSession(twilioCallSid);

  if (!session) {
    logger.debug('Token usage reported for unknown session', {
      twilioCallSid,
      category,
    });
    return;
  }

  const mergedTotals = mergeUsageTotals(session.tokenUsage?.[category], usage);

  const existingUsage: SessionTokenUsage = session.tokenUsage ?? {};

  session.tokenUsage = {
    ...existingUsage,
    [category]: mergedTotals,
  };
}

async function executeHangupCall(
  state: FunctionCallState,
  context: FunctionCallContext
): Promise<void> {
  const { callId } = state;

  if (!callId) {
    logger.warn('Hangup call function invoked without call_id', {
      twilioCallSid: context.twilioCallSid,
    });
    return;
  }

  try {
    await openaiService.hangupCall(callId);
  } catch (error) {
    logger.error('Failed to request OpenAI hangup', {
      callId,
      twilioCallSid: context.twilioCallSid,
      error,
    });
  }

  if (context.openaiWs.readyState === WebSocket.OPEN) {
    context.openaiWs.close(1000, 'Hangup requested by assistant');
  }

  if (context.twilioWs.readyState === WebSocket.OPEN) {
    context.twilioWs.close(1000, 'Hangup requested by assistant');
  }

  try {
    await handleCallEnd(
      context.twilioCallSid,
      context.callConfig,
      context.direction,
      context.from,
      context.to,
      context.executedFunctionCalls
    );
  } catch (error) {
    logger.error('Error handling call end after hangup', {
      twilioCallSid: context.twilioCallSid,
      error,
    });
  }
}

async function handleFunctionCall(
  state: FunctionCallState,
  context: FunctionCallContext
): Promise<void> {
  if (!state.name) {
    logger.warn('Received function call without name from OpenAI', {
      twilioCallSid: context.twilioCallSid,
    });
    return;
  }

  switch (state.name) {
    case 'hangup_call':
      await executeHangupCall(state, context);
      break;
    default:
      logger.warn('Unhandled OpenAI function call', {
        name: state.name,
        twilioCallSid: context.twilioCallSid,
      });
      break;
  }
}

export class MediaStreamHandler {
  /**
   * Handle WebSocket connection for media streaming
   */
  async handleConnection(
    twilioWs: WebSocket,
    callConfig: CallConfig,
    twilioCallSid: string,
    direction: 'inbound' | 'outbound',
    from?: string,
    to?: string
  ): Promise<void> {
    logger.info('Handling media stream connection', { twilioCallSid, direction });

    // Create call session
    sessionManager.createSession(
      twilioCallSid,
      callConfig,
      direction,
      from,
      to
    );

    // Create OpenAI WebSocket connection
    const openaiWs = openaiService.createConnection(callConfig.temperature);

    // Connection state
    let streamSid: string | null = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem: string | null = null;
    let responseStartTimestamp: number | null = null;
    let responseAudioDone = false; // Tracks if OpenAI finished generating audio (but may still be playing)
    const markQueue: string[] = [];
    const executedFunctionCalls: ToolCallPayload[] = [];
    const pendingFunctionCalls = new Map<string, FunctionCallState>();
    const audioPlayout = new TwilioAudioPlayout(
      twilioWs,
      () => streamSid,
      markQueue
    );
    let openaiReadyForInitialResponse = false;
    let twilioReadyForInitialResponse = false;
    let initialResponseTriggered = false;

    const triggerInitialAssistantResponse = (): void => {
      if (
        initialResponseTriggered ||
        !openaiReadyForInitialResponse ||
        !twilioReadyForInitialResponse
      ) {
        return;
      }

      if (openaiWs.readyState !== WebSocket.OPEN) {
        logger.debug('OpenAI WebSocket not ready to trigger initial response');
        return;
      }

      const responseCreate = {
        type: 'response.create',
      };

      openaiWs.send(JSON.stringify(responseCreate), (error) => {
        if (error) {
          logger.error('Failed to trigger initial assistant response', error);
          return;
        }

        initialResponseTriggered = true;
        logger.info('Initial assistant response triggered automatically');
      });
    };

    // Setup OpenAI WebSocket handlers
    openaiWs.on('open', async () => {
      logger.info('OpenAI WebSocket connected');
      
      // Periodically log memory and event loop health in production
      const healthInterval = setInterval(() => {
        const memory = process.memoryUsage();
        const start = performance.now();
        setTimeout(() => {
          const lag = performance.now() - start - 100; // 100ms expected
          const healthData = {rss:Math.round(memory.rss/1024/1024),heapUsed:Math.round(memory.heapUsed/1024/1024),eventLoopLag:Math.round(lag)};
          logger.info('SERVER_HEALTH_REPORT', healthData);
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/887d4abd-dc84-4c10-b9de-e28c1a2adb42',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'mediaStreamHandler.ts:517',message:'SERVER_HEALTH_REPORT',data:healthData,timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B'})}).catch(()=>{});
          // #endregion
          if (lag > 50) {
            logger.warn('Significant event loop lag detected', { lag: Math.round(lag) });
          }
        }, 100);
      }, 5000);

      openaiWs.on('close', () => clearInterval(healthInterval));

      try {
        // Send session configuration
        await openaiService.sendSessionUpdate(openaiWs, callConfig);
      } catch (error) {
        logger.error('Failed to initialize OpenAI session', error);
      }
      // NOTE: We intentionally do NOT mark OpenAI as "ready" here.
      // We wait for the explicit `session.created` event from OpenAI
      // before triggering the initial assistant response, to ensure
      // the session configuration has been fully applied.
    });

    openaiWs.on('message', async (data: WebSocket.Data) => {
      try {
        const event: OpenAIRealtimeEvent = JSON.parse(data.toString());

        // Log conversation item additions for debugging
        if (event.type === 'conversation.item.added' && event.item) {
          logger.info('item added', { 
            role: event.item.role, 
            type: event.item.type,
            id: event.item.id,
          });
        }

        // Log important events
        const logEvents = [
          'error',
          'session.created',
          'session.updated',
          'response.done',
          'input_audio_buffer.speech_started',
          'input_audio_buffer.speech_stopped',
        ];

        if (logEvents.includes(event.type)) {
          logger.debug('OpenAI event received', { type: event.type });
        }

        if (event.type === 'response.done' && event.response?.usage) {
          recordTokenUsage(twilioCallSid, event.response.usage, 'responses');
        }

        if (
          event.type === 'conversation.item.input_audio_transcription.completed' &&
          event.usage
        ) {
          recordTokenUsage(twilioCallSid, event.usage, 'transcriptions');
        }


        if (event.type === 'response.function_call_arguments.delta') {
          const itemId = event.item_id;

          if (itemId) {
            const current = pendingFunctionCalls.get(itemId) ?? { arguments: '' };
            current.toolType = 'function';
            current.arguments += event.delta || '';
            if (event.call_id) current.callId = event.call_id;
            if (event.response_id) current.responseId = event.response_id;
            if (event.tool_call_id) current.toolCallId = event.tool_call_id;
            pendingFunctionCalls.set(itemId, current);
          }
        }

        if (event.type === 'response.function_call_arguments.done') {
          const itemId = event.item_id;

          if (!itemId) {
            logger.warn('Function call done event missing item_id');
          } else {
            const current = pendingFunctionCalls.get(itemId) ?? { arguments: '' };
            current.name = event.name;
            current.arguments = event.arguments ?? current.arguments;
            if (event.call_id) current.callId = event.call_id;
            if (event.response_id) current.responseId = event.response_id;
            if (event.tool_call_id) current.toolCallId = event.tool_call_id;
            pendingFunctionCalls.delete(itemId);

            const toolCall: ToolCallPayload = {
              id: itemId,
              call_id: current.callId,
              response_id: current.responseId,
              tool_call_id: current.toolCallId,
              type: 'function_call',
              name: current.name,
              arguments: current.arguments,
            };
            executedFunctionCalls.push(toolCall);

            await handleFunctionCall(current, {
              openaiWs,
              twilioWs,
              twilioCallSid,
              callConfig,
              direction,
              from,
              to,
              executedFunctionCalls,
            });
          }
        }

        if (event.type === 'response.mcp_call_arguments.delta') {
          const itemId = event.item_id;

          if (itemId) {
            const current = pendingFunctionCalls.get(itemId) ?? { arguments: '' };
            current.toolType = 'mcp';
            current.arguments = (current.arguments || '') + (event.delta || '');
            if (event.call_id) current.callId = event.call_id;
            if (event.response_id) current.responseId = event.response_id;
            if (event.tool_call_id) current.toolCallId = event.tool_call_id;
            pendingFunctionCalls.set(itemId, current);
          }
        }

        if (event.type === 'response.mcp_call_arguments.done') {
          const itemId = event.item_id;

          if (!itemId) {
            logger.warn('MCP call arguments done missing item_id');
          } else {
            const current = pendingFunctionCalls.get(itemId) ?? { arguments: '' };
            current.toolType = 'mcp';
            current.name = event.name;
            current.arguments = event.arguments || current.arguments;
            if (event.call_id) current.callId = event.call_id;
            if (event.response_id) current.responseId = event.response_id;
            if (event.tool_call_id) current.toolCallId = event.tool_call_id;
            pendingFunctionCalls.set(itemId, current);
          }
        }

        if (event.type === 'response.mcp_call.completed') {
          logger.info('MCP call completed, triggering AI response');
          
          const text = [
            'The tool execution is complete.',
            'Please share the results with the caller in a friendly, conversational way.',
            'Be concise and natural.',
          ].join('\n');

          const itemCreate = {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text,
                },
              ],
            },
          };

          const responseCreate = {
            type: 'response.create',
          };

          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify(itemCreate), (error) => {
              if (error) {
                logger.error('Failed to send MCP completion item', error);
                return;
              }
              // Trigger response after item is added
              openaiWs.send(JSON.stringify(responseCreate));
            });
          } else {
            logger.warn('OpenAI WebSocket not open; unable to send MCP summary');
          }
        }

        if (event.type === 'conversation.item.done' && event.item?.type === 'mcp_call') {
          const item = event.item;
          
          const toolCall: ToolCallPayload = {
            id: item.id,
            type: 'mcp_call',
            name: item.name,
            arguments: item.arguments,
            tool_type: 'mcp',
            output: item.output,
          };
          executedFunctionCalls.push(toolCall);
          
          const current = pendingFunctionCalls.get(item.id);
          if (current) {
            pendingFunctionCalls.delete(item.id);
          }
        }

        // Extract conversation ID from session.created and trigger initial response
        if (event.type === 'session.created') {
          if (event.session?.id) {
            sessionManager.updateOpenAIConversationId(
              twilioCallSid,
              event.session.id
            );
          }

          // Only now consider OpenAI "ready" for the first response
          openaiReadyForInitialResponse = true;
          triggerInitialAssistantResponse();
        }

        // Send audio delta to Twilio
        if (event.type === 'response.output_audio.delta' && event.delta) {
          audioPlayout.enqueue(event.delta);

          if (event.item_id && event.item_id !== lastAssistantItem) {
            responseStartTimestamp = latestMediaTimestamp;
            lastAssistantItem = event.item_id;
          }
        }

        if (event.type === 'response.output_audio.done') {
          const genDoneData = {markQueueLength:markQueue.length,bufferLength:audioPlayout.getBufferLength()};
          logger.info('AI_GENERATION_DONE', genDoneData);
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/887d4abd-dc84-4c10-b9de-e28c1a2adb42',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'mediaStreamHandler.ts:743',message:'AI_GENERATION_DONE',data:genDoneData,timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
          // #endregion
          audioPlayout.notifyResponseFinished();
          // Mark that OpenAI finished generating audio, but DON'T reset lastAssistantItem yet
          // We need to wait for actual playback to complete (tracked via marks)
          responseAudioDone = true;
          
          // Send a final mark to know when playback truly finishes
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            void sendMark(twilioWs, streamSid, markQueue);
          }
        }

        // Handle interruption (only if response is still in progress)
        if (event.type === 'input_audio_buffer.speech_started') {
          const interruptionData = {lastAssistantItem,responseStartTimestamp,responseAudioDone,markQueueLength:markQueue.length};
          logger.info('INTERRUPTION_RECEIVED', interruptionData);
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/887d4abd-dc84-4c10-b9de-e28c1a2adb42',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'mediaStreamHandler.ts:772',message:'INTERRUPTION_RECEIVED',data:interruptionData,timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
          // #endregion
          logger.debug('User speech started - handling interruption');
          
          if (lastAssistantItem && responseStartTimestamp !== null) {
            const elapsedTime = latestMediaTimestamp - responseStartTimestamp;
            
            // Truncate OpenAI response
            await openaiService.handleInterruption(
              openaiWs,
              lastAssistantItem,
              elapsedTime
            );

            // Clear Twilio buffer
            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              twilioWs.send(JSON.stringify({
                event: 'clear',
                streamSid,
              }));
            }

            audioPlayout.reset();

            // Reset state
            markQueue.length = 0;
            lastAssistantItem = null;
            responseStartTimestamp = null;
            responseAudioDone = false;
          }
        }

        // Handle errors
        if (event.type === 'error') {
          logger.error('OpenAI error event', event);
        }
      } catch (error) {
        logger.error('Error processing OpenAI message', error);
      }
    });

    openaiWs.on('error', (error) => {
      logger.error('OpenAI WebSocket error', error);
    });

    openaiWs.on('close', () => {
      logger.info('OpenAI WebSocket closed');
    });

    // Setup Twilio WebSocket handlers
    twilioWs.on('message', async (data: WebSocket.Data) => {
      try {
        const message: TwilioMediaEvent = JSON.parse(data.toString());

        switch (message.event) {
          case 'start':
            streamSid = message.start?.streamSid || null;
            const realCallSid = message.start?.callSid;
            logger.info('Twilio stream started', { streamSid, callSid: realCallSid });
            
            if (streamSid) {
              twilioReadyForInitialResponse = true;
              triggerInitialAssistantResponse();
            }

            // Start recording for outbound calls when stream starts (call is answered)
            if (direction === 'outbound' && realCallSid) {
              twilioService.startRecording(realCallSid).catch((error) => {
                logger.error('Failed to start recording on stream start', error);
              });
            }
            break;

          case 'media':
            if (message.media && openaiWs.readyState === WebSocket.OPEN) {
              latestMediaTimestamp = parseInt(message.media.timestamp, 10);
              openaiService.sendAudio(openaiWs, message.media.payload);
            }
            break;

          case 'mark':
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            
            // Check if playback is truly complete (OpenAI done generating AND all marks confirmed)
            if (responseAudioDone && markQueue.length === 0) {
              logger.debug('Playback complete - clearing input buffer and resetting state');
              
              // Clear the input audio buffer to discard any soft acknowledgments
              // that were buffered during AI speech
              openaiService.clearInputAudioBuffer(openaiWs);
              
              // NOW reset the tracking state
              lastAssistantItem = null;
              responseStartTimestamp = null;
              responseAudioDone = false;
            }
            break;

          case 'stop':
            logger.info('Twilio stream stopped', { streamSid });
            audioPlayout.dispose();
            await handleCallEnd(
              twilioCallSid,
              callConfig,
              direction,
              from,
              to,
              executedFunctionCalls
            );
            
            // Close OpenAI connection
            if (openaiWs.readyState === WebSocket.OPEN) {
              openaiWs.close();
            }
            break;
        }
      } catch (error) {
        logger.error('Error processing Twilio message', error);
      }
    });

    twilioWs.on('error', (error) => {
      logger.error('Twilio WebSocket error', error);
    });

    twilioWs.on('close', async () => {
      logger.info('Twilio WebSocket closed');
      audioPlayout.dispose();
      
      // Ensure OpenAI connection is closed
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }

      // Handle call end if not already handled
      await handleCallEnd(
        twilioCallSid,
        callConfig,
        direction,
        from,
        to,
        executedFunctionCalls
      );
    });
  }

  /**
   * Lazy initialization path for when no query params are provided on WS connect.
   * We wait for Twilio 'start' event to extract customParameters (tempId, direction)
   * and initialize OpenAI + session then.
   */
  async handleConnectionLazyInit(
    twilioWs: WebSocket
  ): Promise<void> {
    logger.info('Handling media stream connection (lazy init)');

    let streamSid: string | null = null;
    let twilioCallSid: string | null = null;
    let callConfig: CallConfig | null = null;
    let direction: 'inbound' | 'outbound' = 'outbound';
    let from: string | undefined;
    let to: string | undefined;

    let openaiWs: WebSocket | null = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem: string | null = null;
    let responseStartTimestamp: number | null = null;
    let responseAudioDone = false; // Tracks if OpenAI finished generating audio (but may still be playing)
    const markQueue: string[] = [];
    let initialized = false;
    const executedFunctionCalls: ToolCallPayload[] = [];
    const pendingFunctionCalls = new Map<string, FunctionCallState>();
    const audioPlayout = new TwilioAudioPlayout(
      twilioWs,
      () => streamSid,
      markQueue
    );
    let openaiReadyForInitialResponse = false;
    let twilioReadyForInitialResponse = false;
    let initialResponseTriggered = false;

    const triggerInitialAssistantResponse = (): void => {
      if (
        initialResponseTriggered ||
        !openaiReadyForInitialResponse ||
        !twilioReadyForInitialResponse ||
        !openaiWs
      ) {
        return;
      }

      if (openaiWs.readyState !== WebSocket.OPEN) {
        logger.debug('OpenAI WebSocket not ready to trigger initial response (lazy path)');
        return;
      }

      const responseCreate = {
        type: 'response.create',
      };

      openaiWs.send(JSON.stringify(responseCreate), (error) => {
        if (error) {
          logger.error('Failed to trigger initial assistant response (lazy path)', error);
          return;
        }

        initialResponseTriggered = true;
        logger.info('Initial assistant response triggered automatically (lazy path)');
      });
    };

    const initOpenAI = async () => {
      if (!callConfig || !twilioCallSid) return;

      const ws = openaiService.createConnection(callConfig.temperature);
      openaiWs = ws;

      ws.on('open', async () => {
        logger.info('OpenAI WebSocket connected');

        // Periodically log memory and event loop health in production
        const healthInterval = setInterval(() => {
          const memory = process.memoryUsage();
          const start = performance.now();
          setTimeout(() => {
            const lag = performance.now() - start - 100; // 100ms expected
            const healthData = {rss:Math.round(memory.rss/1024/1024),heapUsed:Math.round(memory.heapUsed/1024/1024),eventLoopLag:Math.round(lag)};
            logger.info('SERVER_HEALTH_REPORT (lazy)', healthData);
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/887d4abd-dc84-4c10-b9de-e28c1a2adb42',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'mediaStreamHandler.ts:938-lazy',message:'SERVER_HEALTH_REPORT',data:healthData,timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A,B'})}).catch(()=>{});
            // #endregion
            if (lag > 50) {
              logger.warn('Significant event loop lag detected (lazy)', { lag: Math.round(lag) });
            }
          }, 100);
        }, 5000);

        ws.on('close', () => clearInterval(healthInterval));

        try {
          await openaiService.sendSessionUpdate(ws, callConfig as CallConfig);
        } catch (error) {
          logger.error('Failed to initialize OpenAI session', error);
        }
        // As in the non-lazy path, wait for `session.created` before
        // treating OpenAI as ready for the first response.
      });

      ws.on('message', async (data: WebSocket.Data) => {
        try {
          const event: OpenAIRealtimeEvent = JSON.parse(data.toString());

          // Log conversation item additions for debugging
          if (event.type === 'conversation.item.added' && event.item) {
            logger.info('item added', { 
              role: event.item.role, 
              type: event.item.type,
              id: event.item.id,
            });
          }

          const logEvents = [
            'error',
            'session.created',
            'session.updated',
            'response.done',
            'input_audio_buffer.speech_started',
            'input_audio_buffer.speech_stopped',
          ];
          if (logEvents.includes(event.type)) {
            logger.debug('OpenAI event received', { type: event.type });
          }


          if (twilioCallSid && event.type === 'response.done' && event.response?.usage) {
            recordTokenUsage(twilioCallSid, event.response.usage, 'responses');
          }

          if (
            twilioCallSid &&
            event.type === 'conversation.item.input_audio_transcription.completed' &&
            event.usage
          ) {
            recordTokenUsage(twilioCallSid, event.usage, 'transcriptions');
          }


          if (event.type === 'response.function_call_arguments.delta') {
            const itemId = event.item_id;
            if (itemId) {
              const current = pendingFunctionCalls.get(itemId) ?? { arguments: '' };
              current.toolType = 'function';
              current.arguments += event.delta || '';
              if (event.call_id) current.callId = event.call_id;
              if (event.response_id) current.responseId = event.response_id;
              if (event.tool_call_id) current.toolCallId = event.tool_call_id;
              pendingFunctionCalls.set(itemId, current);
            }
          }
          if (event.type === 'response.function_call_arguments.done') {
            if (!callConfig || !twilioCallSid) {
              logger.warn('Function call completed before session initialization');
            } else {
              const itemId = event.item_id;
              if (!itemId) {
                logger.warn('Function call done event missing item_id');
              } else {
                const current = pendingFunctionCalls.get(itemId) ?? { arguments: '' };
                current.toolType = 'function';
                current.name = event.name;
                current.arguments = event.arguments ?? current.arguments;
                if (event.call_id) current.callId = event.call_id;
                if (event.response_id) current.responseId = event.response_id;
                if (event.tool_call_id) current.toolCallId = event.tool_call_id;
                pendingFunctionCalls.delete(itemId);

                const toolCall: ToolCallPayload = {
                  id: itemId,
                  call_id: current.callId,
                  response_id: current.responseId,
                  tool_call_id: current.toolCallId,
                  type: 'function_call',
                  name: current.name,
                  arguments: current.arguments,
                  tool_type: 'function',
                };
                executedFunctionCalls.push(toolCall);

                await handleFunctionCall(current, {
                  openaiWs: ws,
                  twilioWs,
                  twilioCallSid: twilioCallSid as string,
                  callConfig: callConfig as CallConfig,
                  direction,
                  from,
                  to,
                  executedFunctionCalls,
                });
              }
            }
          }
          if (event.type === 'response.mcp_call_arguments.delta') {
            const itemId = event.item_id;
            if (itemId) {
              const current = pendingFunctionCalls.get(itemId) ?? { arguments: '' };
              current.toolType = 'mcp';
              current.arguments = (current.arguments || '') + (event.delta || '');
              if (event.call_id) current.callId = event.call_id;
              if (event.response_id) current.responseId = event.response_id;
              if (event.tool_call_id) current.toolCallId = event.tool_call_id;
              pendingFunctionCalls.set(itemId, current);
            }
          }
          if (event.type === 'response.mcp_call_arguments.done') {
            const itemId = event.item_id;
            if (!itemId) {
              logger.warn('MCP call arguments done missing item_id (lazy path)');
            } else {
              const current = pendingFunctionCalls.get(itemId) ?? { arguments: '' };
              current.toolType = 'mcp';
              current.name = event.name;
              current.arguments = event.arguments || current.arguments;
              if (event.call_id) current.callId = event.call_id;
              if (event.response_id) current.responseId = event.response_id;
              if (event.tool_call_id) current.toolCallId = event.tool_call_id;
              pendingFunctionCalls.set(itemId, current);
            }
          }
          if (event.type === 'response.mcp_call.completed') {
            logger.info('MCP call completed, triggering AI response (lazy path)');
            
            const text = [
              'The tool execution is complete.',
              'Please share the results with the caller in a friendly, conversational way.',
              'Be concise and natural.',
            ].join('\n');

            const itemCreate = {
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text,
                  },
                ],
              },
            };

            const responseCreate = {
              type: 'response.create',
            };

            const ws = openaiWs;
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(itemCreate), (error) => {
                if (error) {
                  logger.error('Failed to send MCP completion item (lazy path)', error);
                  return;
                }
                // Trigger response after item is added
                ws.send(JSON.stringify(responseCreate));
              });
            } else {
              logger.warn('OpenAI WebSocket not open; unable to send MCP summary (lazy path)');
            }
          }
          if (event.type === 'conversation.item.done' && event.item?.type === 'mcp_call') {
            const item = event.item;
            
            const toolCall: ToolCallPayload = {
              id: item.id,
              type: 'mcp_call',
              name: item.name,
              arguments: item.arguments,
              tool_type: 'mcp',
              output: item.output,
            };
            executedFunctionCalls.push(toolCall);
            
            const current = pendingFunctionCalls.get(item.id);
            if (current) {
              pendingFunctionCalls.delete(item.id);
            }
          }
          if (event.type === 'session.created') {
            if (event.session?.id) {
              sessionManager.updateOpenAIConversationId(
                twilioCallSid as string,
                event.session.id
              );
            }

            openaiReadyForInitialResponse = true;
            triggerInitialAssistantResponse();
          }
          if (event.type === 'response.output_audio.delta' && event.delta) {
            audioPlayout.enqueue(event.delta);
            if (event.item_id && event.item_id !== lastAssistantItem) {
              responseStartTimestamp = latestMediaTimestamp;
              lastAssistantItem = event.item_id;
            }
          }
          if (event.type === 'response.output_audio.done') {
            const genDoneData = {markQueueLength:markQueue.length,bufferLength:audioPlayout.getBufferLength()};
            logger.info('AI_GENERATION_DONE (lazy)', genDoneData);
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/887d4abd-dc84-4c10-b9de-e28c1a2adb42',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'mediaStreamHandler.ts:1159-lazy',message:'AI_GENERATION_DONE',data:genDoneData,timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
            // #endregion
            audioPlayout.notifyResponseFinished();
            // Mark that OpenAI finished generating audio, but DON'T reset lastAssistantItem yet
            // We need to wait for actual playback to complete (tracked via marks)
            responseAudioDone = true;
            
            // Send a final mark to know when playback truly finishes
            if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
              void sendMark(twilioWs, streamSid, markQueue);
            }
          }
          if (event.type === 'input_audio_buffer.speech_started') {
            const interruptionData = {lastAssistantItem,responseStartTimestamp,responseAudioDone,markQueueLength:markQueue.length};
            logger.info('INTERRUPTION_RECEIVED (lazy)', interruptionData);
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/887d4abd-dc84-4c10-b9de-e28c1a2adb42',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'mediaStreamHandler.ts:1174-lazy',message:'INTERRUPTION_RECEIVED',data:interruptionData,timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'A'})}).catch(()=>{});
            // #endregion
            logger.debug('User speech started - handling interruption');
            if (lastAssistantItem && responseStartTimestamp !== null) {
              const elapsedTime = latestMediaTimestamp - responseStartTimestamp;
              await openaiService.handleInterruption(
                ws,
                lastAssistantItem,
                elapsedTime
              );
              if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
                twilioWs.send(JSON.stringify({ event: 'clear', streamSid }));
              }
              audioPlayout.reset();
              markQueue.length = 0;
              lastAssistantItem = null;
              responseStartTimestamp = null;
              responseAudioDone = false;
            }
          }
          if (event.type === 'error') {
            logger.error('OpenAI error event', event);
          }
        } catch (error) {
          logger.error('Error processing OpenAI message', error);
        }
      });

      ws.on('error', (error) => {
        logger.error('OpenAI WebSocket error', error);
      });

      ws.on('close', () => {
        logger.info('OpenAI WebSocket closed');
      });
    };

    twilioWs.on('message', async (data: WebSocket.Data) => {
      try {
        const message: TwilioMediaEvent = JSON.parse(data.toString());
        switch (message.event) {
          case 'start': {
            streamSid = message.start?.streamSid || null;
            twilioCallSid = message.start?.callSid || null;
            const params = message.start?.customParameters || {};
            const tempId = params['tempId'];
            const dir = (params['direction'] as 'inbound' | 'outbound') || 'outbound';
            direction = dir;
            logger.info('Twilio stream started (lazy init)', { streamSid, twilioCallSid, direction, tempId });

            if (!twilioCallSid) {
              logger.error('Missing callSid in Twilio start event');
              twilioWs.close();
              return;
            }
            if (streamSid) {
              twilioReadyForInitialResponse = true;
              triggerInitialAssistantResponse();
            }

            if (dir === 'outbound') {
              if (!tempId) {
                logger.error('Missing tempId in customParameters for outbound lazy init');
                twilioWs.close();
                return;
              }
              const tempSession = sessionManager.getSession(tempId);
              if (!tempSession) {
                logger.error('Temporary session not found for outbound lazy init', { tempId });
                twilioWs.close(1008, 'Session not found');
                return;
              }
              callConfig = tempSession.config;
              from = tempSession.from;
              to = tempSession.to;
              // Create real session with actual CallSid
              sessionManager.createSession(
                twilioCallSid,
                callConfig,
                'outbound',
                from,
                to
              );

              // Start recording now that the outbound stream is live
              twilioService.startRecording(twilioCallSid).catch((error) => {
                logger.error('Failed to start recording on stream start (lazy path)', error);
              });
            } else {
              // Inbound call - extract from/to from customParameters
              from = params['from'];
              to = params['to'];
              
              if (!from || !to) {
                logger.error('Missing from/to in customParameters for inbound lazy init');
                twilioWs.close(1008, 'Invalid parameters');
                return;
              }

              // Try to use a prefetched session first
              const existingSession = sessionManager.getSession(twilioCallSid);
              if (existingSession) {
                callConfig = existingSession.config;
                logger.info('Using prefetched inbound config from session (lazy init)', { twilioCallSid });
              } else {
                // Fetch configuration from n8n webhook
                const n8nWebhookUrl = config.n8n.defaultWebhookUrl;
                
                if (n8nWebhookUrl) {
                  const configRequest = {
                    event: 'call.started' as const,
                    twilio_call_sid: twilioCallSid,
                    from,
                    to,
                    timestamp: new Date().toISOString(),
                  };

                  callConfig = await n8nService.fetchConfig(n8nWebhookUrl, configRequest);
                } else {
                  // Use default config if no webhook URL configured
                  callConfig = n8nService.getDefaultConfig('');
                  logger.warn('No default n8n webhook URL configured, using default config');
                }
              }

              // Create session for inbound call
              sessionManager.createSession(
                twilioCallSid,
                callConfig,
                'inbound',
                from,
                to
              );

              logger.info('Inbound call initialized via lazy path', { twilioCallSid, from, to });
            }

            await initOpenAI();
            initialized = true;
            break;
          }
          case 'media': {
            if (!initialized || !openaiWs || openaiWs.readyState !== WebSocket.OPEN) {
              return;
            }
            if (message.media) {
              latestMediaTimestamp = parseInt(message.media.timestamp, 10);
              openaiService.sendAudio(openaiWs!, message.media.payload);
            }
            break;
          }
          case 'mark': {
            if (markQueue.length > 0) {
              markQueue.shift();
            }
            
            // Check if playback is truly complete (OpenAI done generating AND all marks confirmed)
            if (responseAudioDone && markQueue.length === 0 && openaiWs) {
              logger.debug('Playback complete - clearing input buffer and resetting state (lazy path)');
              
              // Clear the input audio buffer to discard any soft acknowledgments
              // that were buffered during AI speech
              openaiService.clearInputAudioBuffer(openaiWs);
              
              // NOW reset the tracking state
              lastAssistantItem = null;
              responseStartTimestamp = null;
              responseAudioDone = false;
            }
            break;
          }
          case 'stop': {
            logger.info('Twilio stream stopped', { streamSid });
            audioPlayout.dispose();
            if (twilioCallSid && callConfig) {
              await handleCallEnd(
                twilioCallSid,
                callConfig,
                direction,
                from,
                to,
                executedFunctionCalls
              );
            }
            if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
              openaiWs.close();
            }
            break;
          }
        }
      } catch (error) {
        logger.error('Error processing Twilio message (lazy init)', error);
      }
    });

    twilioWs.on('error', (error) => {
      logger.error('Twilio WebSocket error', error);
    });

    twilioWs.on('close', async () => {
      logger.info('Twilio WebSocket closed');
      audioPlayout.dispose();
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
      if (twilioCallSid && callConfig) {
        await handleCallEnd(
          twilioCallSid,
          callConfig,
          direction,
          from,
          to,
          executedFunctionCalls
        );
      }
    });
  }
}

/**
 * Send mark event to Twilio
 */
async function sendMark(
  ws: WebSocket,
  streamSid: string,
  markQueue: string[]
): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) {
    const markEvent = {
      event: 'mark',
      streamSid,
      mark: { name: 'responsePart' },
    };
    ws.send(JSON.stringify(markEvent));
    markQueue.push('responsePart');
  }
}

/**
 * Handle call end and send completion webhook
 */
async function handleCallEnd(
  twilioCallSid: string,
  callConfig: CallConfig,
  direction: 'inbound' | 'outbound',
  from?: string,
  to?: string,
  toolCalls?: ToolCallPayload[]
): Promise<void> {
  // Idempotency guard - ensure we only process completion once per call
  if (completedCallSids.has(twilioCallSid)) {
    return;
  }

  // Try to retrieve session data without removing it yet
  let session = sessionManager.getSession(twilioCallSid);

  // Mark as ended (sets endTime) if we still have the session in memory
  if (session) {
    session = sessionManager.endSession(twilioCallSid);
  } else {
    // No session available - proceed with minimal data instead of dropping the webhook
    logger.debug('Session missing at call end, sending minimal completion webhook', { twilioCallSid });
  }

  const duration = session?.endTime && session?.startTime
    ? Math.floor((session.endTime.getTime() - session.startTime.getTime()) / 1000)
    : undefined;

  const completionData: N8nCompletionWebhook = {
    event: 'call.completed',
    twilio_call_sid: twilioCallSid,
    openai_conversation_id: session?.openaiConversationId || 'unknown',
    from,
    to,
    direction,
    duration,
    status: 'completed',
    metadata: session?.config.metadata || callConfig.metadata,
    timestamp: new Date().toISOString(),
  };

  if (toolCalls && toolCalls.length > 0) {
    completionData.tool_calls = toolCalls;
  }

  if (session?.tokenUsage) {
    completionData.token_usage = session.tokenUsage;
  }

  // Send completion webhook; only mark completed on success
  const sent = await n8nService.sendCompletionWebhook(
    callConfig.webhook_url,
    completionData
  );

  if (sent) {
    completedCallSids.add(twilioCallSid);
    if (session) {
      sessionManager.removeSession(twilioCallSid);
    }
    // Allow the set to be cleaned after a short delay to avoid unbounded growth
    setTimeout(() => completedCallSids.delete(twilioCallSid), 5 * 60 * 1000);
  } else {
    logger.warn('Completion webhook failed to send; will allow retry on subsequent close/stop', { twilioCallSid });
  }
}

export const mediaStreamHandler = new MediaStreamHandler();

