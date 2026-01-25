// Type definitions for Twilio + OpenAI Realtime API integration

export interface TurnDetectionConfig {
  type: 'server_vad' | 'semantic_vad';
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
  eagerness?: 'low' | 'medium' | 'high' | 'auto';
  // semantic_vad may support different/extra fields; keep open for forward compatibility
  [key: string]: any;
}

export interface ToolConfig {
  type: 'function' | 'mcp';
  // For function type
  name?: string;
  description?: string;
  parameters?: object;
  // For MCP types
  server_label?: string;
  server_url?: string;
  require_approval?: 'always' | 'never' | 'auto';
}

export interface CallConfig {
  voice?: string;
  model?: string;
  instructions?: string;
  temperature?: number;
  modalities?: string[];
  turn_detection?: TurnDetectionConfig;
  tools?: ToolConfig[];
  metadata?: Record<string, any>;
  webhook_url: string;
}

export interface OutboundCallRequest extends CallConfig {
  to: string;
  from?: string;
}

export interface OutboundCallResponse {
  success: boolean;
  twilio_call_sid: string;
  openai_conversation_id?: string;
  status: string;
  message?: string;
}

export interface N8nConfigRequest {
  event: 'call.started';
  twilio_call_sid: string;
  from: string;
  to: string;
  timestamp: string;
}

export interface ToolCallPayload {
  id: string;
  call_id?: string;
  response_id?: string;
  tool_call_id?: string;
  type: 'function_call' | 'custom_tool_call' | 'mcp_call';
  name?: string;
  arguments?: string;
  tool_type?: 'function' | 'mcp';
  output?: string;
}

export interface TokenUsageBreakdown {
  text_tokens?: number;
  audio_tokens?: number;
  image_tokens?: number;
  cached_tokens?: number;
}

export interface TokenUsageDetails extends TokenUsageBreakdown {
  cached_tokens_details?: TokenUsageBreakdown;
}

export interface OpenAITokenUsageTotals {
  total_tokens: number;
  input_tokens?: number;
  output_tokens?: number;
  event_count?: number;
  input_token_details?: TokenUsageDetails;
  output_token_details?: TokenUsageDetails;
}

export interface SessionTokenUsage {
  responses?: OpenAITokenUsageTotals;
  transcriptions?: OpenAITokenUsageTotals;
}

export interface N8nCompletionWebhook {
  event: 'call.completed';
  twilio_call_sid: string;
  openai_conversation_id: string;
  from?: string;
  to?: string;
  direction: 'inbound' | 'outbound';
  duration?: number;
  status: string;
  metadata?: Record<string, any>;
  timestamp: string;
  tool_calls?: ToolCallPayload[];
  token_usage?: SessionTokenUsage;
}

export interface OpenAISessionConfig {
  type: 'realtime';
  output_modalities: string[];
  audio: {
    input: {
      format: {
        type: string;
      };
      turn_detection: TurnDetectionConfig;
      /**
       * Explicit transcription configuration for input audio.
       * We set this to null in our session to ensure model-side
       * transcription remains disabled (we transcribe post-call in n8n).
       */
       transcription?: null | Record<string, any>;
    };
    output: {
      format: {
        type: string;
      };
      voice: string;
    };
  };
  instructions?: string;
  tools?: ToolConfig[];
  truncation?: {
    type: 'retention_ratio' | 'none';
    retention_ratio?: number;
  };
}

export interface CallSession {
  twilioCallSid: string;
  openaiConversationId?: string;
  config: CallConfig;
  direction: 'inbound' | 'outbound';
  from?: string;
  to?: string;
  startTime: Date;
  endTime?: Date;
  tokenUsage?: SessionTokenUsage;
}

export interface TwilioMediaEvent {
  event: 'media' | 'start' | 'mark' | 'stop';
  sequenceNumber?: string;
  media?: {
    track: string;
    chunk: string;
    timestamp: string;
    payload: string;
  };
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
    customParameters?: Record<string, string>;
  };
  mark?: {
    name: string;
  };
  streamSid?: string;
}

export interface OpenAIRealtimeEvent {
  type: string;
  event_id?: string;
  [key: string]: any;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}
