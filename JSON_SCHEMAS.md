# JSON Schema Reference

This document provides complete JSON schemas for all API requests and responses.

## Table of Contents

1. [Outbound Call Request](#outbound-call-request)
2. [Outbound Call Response](#outbound-call-response)
3. [N8N Configuration Request](#n8n-configuration-request)
4. [N8N Configuration Response](#n8n-configuration-response)
5. [N8N Completion Webhook](#n8n-completion-webhook)
6. [Error Response](#error-response)

---

## Outbound Call Request

**Endpoint:** `POST /outbound-call`

### Complete Schema

```json
{
  "to": "+1234567890",
  "from": "+0987654321",
  "voice": "shimmer",
  "model": "gpt-realtime",
  "instructions": "You are a helpful AI assistant.",
  "temperature": 0.8,
  "welcome_greeting": "Hello! How can I help you today?",
  "modalities": ["audio"],
  "turn_detection": {
    "type": "server_vad",
    "threshold": 0.5,
    "prefix_padding_ms": 300,
    "silence_duration_ms": 500
  },
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "Get the current weather for a location",
      "parameters": {
        "type": "object",
        "properties": {
          "location": {
            "type": "string",
            "description": "City name"
          }
        },
        "required": ["location"]
      }
    },
    {
      "type": "mcp",
      "server_label": "appointment_tools",
      "server_url": "https://your-n8n.com/mcp/tools",
      "require_approval": "never"
    }
  ],
  "metadata": {
    "user_id": "12345",
    "campaign_id": "67890",
    "custom_field": "any value"
  },
  "webhook_url": "https://your-n8n.com/webhook/call-completed"
}
```

### Field Definitions

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `to` | string | ✅ Yes | - | Phone number to call (E.164 format) |
| `from` | string | ❌ No | `TWILIO_PHONE_NUMBER` | Twilio number to call from |
| `voice` | string | ❌ No | `alloy` | OpenAI voice ID |
| `model` | string | ❌ No | `gpt-realtime` | OpenAI model |
| `instructions` | string | ❌ No | - | System prompt for AI behavior |
| `temperature` | number | ❌ No | `0.8` | Randomness (0.0 - 1.0) |
| `welcome_greeting` | string | ❌ No | - | Initial AI message |
| `modalities` | string[] | ❌ No | `["audio"]` | Output modalities |
| `turn_detection` | object | ❌ No | See below | Voice activity detection config |
| `tools` | array | ❌ No | `[]` | Function calling tools |
| `metadata` | object | ❌ No | `{}` | Custom tracking data |
| `webhook_url` | string | ✅ Yes | - | Completion webhook URL |

### Turn Detection Schema

```json
{
  "type": "server_vad",
  "threshold": 0.5,
  "prefix_padding_ms": 300,
  "silence_duration_ms": 500
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `type` | string | ✅ Yes | - | Must be `"server_vad"` |
| `threshold` | number | ❌ No | `0.5` | Detection sensitivity (0.0 - 1.0) |
| `prefix_padding_ms` | number | ❌ No | `300` | Audio before speech (ms) |
| `silence_duration_ms` | number | ❌ No | `500` | Silence to end turn (ms) |

### Tool Schema (Function)

```json
{
  "type": "function",
  "name": "function_name",
  "description": "What this function does",
  "parameters": {
    "type": "object",
    "properties": {
      "param1": {
        "type": "string",
        "description": "Parameter description"
      }
    },
    "required": ["param1"]
  }
}
```

### Tool Schema (MCP)

```json
{
  "type": "mcp",
  "server_label": "my_mcp_server",
  "server_url": "https://example.com/mcp/endpoint",
  "require_approval": "never"
}
```

| Field | Type | Required | Values | Description |
|-------|------|----------|--------|-------------|
| `type` | string | ✅ Yes | `"mcp"` | Tool type |
| `server_label` | string | ✅ Yes | - | MCP server identifier |
| `server_url` | string | ✅ Yes | - | MCP server endpoint |
| `require_approval` | string | ❌ No | `"always"`, `"never"`, `"auto"` | Approval requirement |

### Voice Options

Available voices:
- `alloy` (default)
- `echo`
- `fable`
- `onyx`
- `nova`
- `shimmer`
- `marin`

---

## Outbound Call Response

### Success Response

```json
{
  "success": true,
  "twilio_call_sid": "CA1234567890abcdef1234567890abcdef",
  "openai_conversation_id": "conv_abc123xyz789",
  "status": "initiated",
  "message": "Outbound call initiated successfully"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always `true` for success |
| `twilio_call_sid` | string | Twilio Call SID |
| `openai_conversation_id` | string | OpenAI conversation ID (may be null initially) |
| `status` | string | Call status (e.g., "initiated", "queued", "ringing") |
| `message` | string | Human-readable message |

---

## N8N Configuration Request

**Sent by server to:** `DEFAULT_N8N_WEBHOOK_URL`

### Schema

```json
{
  "event": "call.started",
  "twilio_call_sid": "CA1234567890abcdef1234567890abcdef",
  "from": "+1234567890",
  "to": "+0987654321",
  "timestamp": "2025-11-04T10:00:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | Always `"call.started"` |
| `twilio_call_sid` | string | Twilio Call SID |
| `from` | string | Caller's phone number |
| `to` | string | Twilio number called |
| `timestamp` | string | ISO 8601 timestamp |

---

## N8N Configuration Response

**Expected response from:** `DEFAULT_N8N_WEBHOOK_URL`

### Minimal Response

```json
{
  "webhook_url": "https://your-n8n.com/webhook/call-completed"
}
```

### Complete Response

```json
{
  "voice": "shimmer",
  "model": "gpt-realtime",
  "instructions": "You are a friendly customer service agent for Acme Corp. Be helpful and professional.",
  "temperature": 0.7,
  "welcome_greeting": "Thank you for calling Acme Corp! My name is Sarah, how can I help you today?",
  "modalities": ["audio"],
  "turn_detection": {
    "type": "server_vad",
    "threshold": 0.5,
    "silence_duration_ms": 700
  },
  "tools": [
    {
      "type": "mcp",
      "server_label": "customer_tools",
      "server_url": "https://your-n8n.com/mcp/customer-tools",
      "require_approval": "never"
    }
  ],
  "metadata": {
    "customer_id": "12345",
    "customer_tier": "gold",
    "agent_name": "Sarah"
  },
  "webhook_url": "https://your-n8n.com/webhook/call-completed"
}
```

**Note:** All fields except `webhook_url` are optional. The server will use defaults for missing fields.

---

## N8N Completion Webhook

**Sent by server to:** `webhook_url` from configuration

### Schema

```json
{
  "event": "call.completed",
  "twilio_call_sid": "CA1234567890abcdef1234567890abcdef",
  "openai_conversation_id": "conv_abc123xyz789",
  "from": "+1234567890",
  "to": "+0987654321",
  "direction": "inbound",
  "duration": 127,
  "status": "completed",
  "metadata": {
    "customer_id": "12345",
    "customer_tier": "gold"
  },
  "timestamp": "2025-11-04T10:02:07.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | Always `"call.completed"` |
| `twilio_call_sid` | string | Twilio Call SID |
| `openai_conversation_id` | string | OpenAI conversation ID |
| `from` | string | Caller/calling phone number |
| `to` | string | Recipient phone number |
| `direction` | string | `"inbound"` or `"outbound"` |
| `duration` | number | Call duration in seconds |
| `status` | string | Call status |
| `metadata` | object | Pass-through from configuration |
| `timestamp` | string | ISO 8601 timestamp |

### Status Values

- `completed` - Call ended normally
- `failed` - Call failed
- `no-answer` - No answer
- `busy` - Line busy
- `canceled` - Call canceled

---

## Error Response

### Schema

```json
{
  "success": false,
  "error": {
    "code": "MISSING_REQUIRED_FIELD",
    "message": "Missing required field: to",
    "details": {
      "field": "to",
      "expected": "string (E.164 format)"
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Always `false` for errors |
| `error.code` | string | Error code |
| `error.message` | string | Human-readable error message |
| `error.details` | any | Additional error details |

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `MISSING_REQUIRED_FIELD` | 400 | Required field not provided |
| `INVALID_REQUEST` | 400 | Malformed request |
| `TWILIO_ERROR` | 500 | Twilio API error |
| `OPENAI_ERROR` | 500 | OpenAI API error |
| `WEBHOOK_ERROR` | 500 | N8N webhook error |
| `INTERNAL_ERROR` | 500 | Server error |

---

## Example Workflows

### Example 1: Simple Outbound Call

**Request:**
```json
{
  "to": "+1234567890",
  "instructions": "You are calling to confirm an appointment.",
  "welcome_greeting": "Hi, this is a reminder about your appointment tomorrow at 2 PM. Can you confirm?",
  "webhook_url": "https://your-n8n.com/webhook/completed"
}
```

### Example 2: Advanced Configuration

**Request:**
```json
{
  "to": "+1234567890",
  "from": "+0987654321",
  "voice": "marin",
  "instructions": "You are Eva, a healthcare assistant. Be empathetic and professional.",
  "temperature": 0.6,
  "welcome_greeting": "Hi, this is Eva from HealthCare Plus. I'm calling to check on your medication refill.",
  "turn_detection": {
    "type": "server_vad",
    "threshold": 0.6,
    "silence_duration_ms": 800
  },
  "tools": [
    {
      "type": "mcp",
      "server_label": "healthcare_tools",
      "server_url": "https://your-n8n.com/mcp/healthcare",
      "require_approval": "never"
    }
  ],
  "metadata": {
    "patient_id": "P12345",
    "prescription_id": "RX67890",
    "call_reason": "medication_refill"
  },
  "webhook_url": "https://your-n8n.com/webhook/healthcare-completed"
}
```

### Example 3: Inbound Call Configuration (n8n Response)

**n8n Response:**
```json
{
  "voice": "shimmer",
  "instructions": "You are a virtual receptionist for Dr. Smith's office. Be friendly and help schedule appointments.",
  "welcome_greeting": "Thank you for calling Dr. Smith's office! How can I help you today?",
  "tools": [
    {
      "type": "function",
      "name": "check_availability",
      "description": "Check doctor's availability for appointments",
      "parameters": {
        "type": "object",
        "properties": {
          "date": {
            "type": "string",
            "description": "Date in YYYY-MM-DD format"
          },
          "time_preference": {
            "type": "string",
            "enum": ["morning", "afternoon", "evening"]
          }
        },
        "required": ["date"]
      }
    }
  ],
  "metadata": {
    "office_id": "OFF123",
    "doctor_id": "DOC456"
  },
  "webhook_url": "https://your-n8n.com/webhook/appointment-completed"
}
```

---

## Validation Rules

### Phone Numbers
- Must be in E.164 format: `+[country code][number]`
- Example: `+1234567890`
- No spaces, dashes, or parentheses

### Temperature
- Type: `number`
- Range: `0.0` to `1.0`
- Lower = more deterministic
- Higher = more creative

### Webhook URLs
- Must be valid HTTPS URLs
- Must be accessible from the server
- Should respond within 10 seconds

### Metadata
- Can be any valid JSON object
- Recommended max size: 1 KB
- Avoid sensitive data (PII)

---

## TypeScript Interfaces

For TypeScript users, here are the corresponding interfaces:

```typescript
interface OutboundCallRequest {
  to: string;
  from?: string;
  voice?: string;
  model?: string;
  instructions?: string;
  temperature?: number;
  welcome_greeting?: string;
  modalities?: string[];
  turn_detection?: TurnDetectionConfig;
  tools?: ToolConfig[];
  metadata?: Record<string, any>;
  webhook_url: string;
}

interface TurnDetectionConfig {
  type: 'server_vad';
  threshold?: number;
  prefix_padding_ms?: number;
  silence_duration_ms?: number;
}

interface ToolConfig {
  type: 'function' | 'mcp';
  name?: string;
  description?: string;
  parameters?: object;
  server_label?: string;
  server_url?: string;
  require_approval?: 'always' | 'never' | 'auto';
}

interface OutboundCallResponse {
  success: boolean;
  twilio_call_sid: string;
  openai_conversation_id?: string;
  status: string;
  message?: string;
}

interface N8nCompletionWebhook {
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
}
```

These interfaces are available in `src/types/index.ts`.
