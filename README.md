# Twilio + OpenAI Realtime API Backend

This project provides a robust backend server built with Node.js, TypeScript, and Express to integrate Twilio Voice with the OpenAI Realtime API. It enables dynamic, AI-powered voice conversations, supporting both inbound and outbound calls with real-time, configurable AI behavior.

## Features

- **Inbound & Outbound Calls**: Handles both incoming calls via Twilio webhooks and can trigger outbound calls through a REST API.
- **Dynamic Configuration**: Fetches call configurations (AI voice, instructions, etc.) from an n8n webhook for inbound calls, allowing for dynamic agent behavior based on the caller.
- **WebSocket Integration**: Uses WebSockets to stream audio between Twilio Media Streams and the OpenAI Realtime API for low-latency conversations.
- **Full OpenAI Realtime API Support**: Supports the full range of GA features, including different voices, models, temperature, tools (function calling), and server-side voice activity detection (VAD).
- **Completion Webhooks**: Notifies an n8n instance with call details (Twilio Call SID, OpenAI Conversation ID) upon call completion.
- **TypeScript & Modern Tooling**: Built with TypeScript for type safety and includes a modern project setup with `pnpm`, `nodemon`, and `ts-node` for development.
- **Comprehensive Error Handling & Logging**: Includes structured logging and graceful error handling.

## Prerequisites

Before you begin, ensure you have the following:

- **Node.js v18+** and **pnpm**
- A **Twilio account** with a voice-enabled phone number.
- An **OpenAI account** with access to the Realtime API and an API key.
- An **n8n instance** (or any webhook provider) to handle configuration and completion webhooks.
- **ngrok** or a similar tunneling service to expose your local server to the internet for Twilio webhooks.

## Project Setup

1.  **Clone the repository:**
    ```bash
    git clone <repository-url>
    cd twilio-openai-realtime
    ```

2.  **Install dependencies:**
    ```bash
    pnpm install
    ```

3.  **Configure Environment Variables:**

    Copy the `.env.example` file to a new `.env` file:
    ```bash
    cp .env.example .env
    ```

    Then, fill in the values in your `.env` file:

    | Variable                  | Description                                                                 |
    | ------------------------- | --------------------------------------------------------------------------- |
    | `TWILIO_ACCOUNT_SID`      | Your Twilio Account SID.                                                    |
    | `TWILIO_AUTH_TOKEN`       | Your Twilio Auth Token.                                                     |
    | `TWILIO_PHONE_NUMBER`     | Your Twilio phone number in E.164 format (e.g., +1234567890).               |
    | `OPENAI_API_KEY`          | Your OpenAI API key.                                                        |
    | `N8N_WEBHOOK_AUTH`        | The authentication header value for your n8n webhooks (`lgvaibot0902!`).    |
    | `N8N_REQUEST_TIMEOUT_MS`  | Timeout (ms) for server->n8n HTTP calls (defaults to `35000`).              |
    | `N8N_INBOUND_PREFETCH_TIMEOUT_MS` | Max prefetch wait (ms) before replying TwiML on inbound calls (capped at `14000`). |
    | `PORT`                    | The port for the server to run on (defaults to `5050`).                     |
    | `DEFAULT_N8N_WEBHOOK_URL` | The default n8n webhook URL to fetch configuration from for inbound calls.  |

## Running the Application

1.  **Start the development server:**
    ```bash
    pnpm dev
    ```
    This will start the server with `nodemon`, which automatically restarts on file changes.

2.  **Expose your local server with ngrok:**
    ```bash
    ngrok http 5050
    ```
    Copy the `https` forwarding URL provided by ngrok.

3.  **Configure Twilio Webhook:**

    - Go to your Twilio phone number's configuration in the Twilio Console.
    - Under "A CALL COMES IN", set the webhook to your ngrok URL, pointing to the `/incoming-call` endpoint.
    - Example: `https://<your-ngrok-subdomain>.ngrok.io/incoming-call`
    - Set the HTTP method to `POST`.

## API Reference

### `POST /outbound-call`

Initiates an outbound call with a specified configuration.

**Request Body:**

```json
{
  "to": "+1234567890",
  "from": "+1987654321",
  "voice": "marin",
  "instructions": "You are a helpful assistant.",
  "static_message": "We cannot connect your call right now. Please try again tomorrow.",
  "welcome_greeting": "Hello, how can I help you today?",
  "webhook_url": "https://your-n8n-instance.com/webhook/call-completed",
  "metadata": { "user_id": "123" }
}
```

`static_message` is optional. When provided, Twilio will play that message using `<Say>` and then hang up, without opening the AI media stream.

**Response:**

```json
{
  "success": true,
  "twilio_call_sid": "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "status": "initiated",
  "message": "Outbound call initiated successfully"
}
```

### `POST /incoming-call`

This is the webhook endpoint for Twilio. It returns TwiML to connect the call to the server's WebSocket for media streaming.
The server keeps prefetch wait below Twilio's call webhook timeout ceiling and continues fetching config in the background if needed.

### `WS /media-stream`

This WebSocket endpoint handles the real-time audio streaming between Twilio and OpenAI.

## Webhook Payloads

### N8N Configuration Webhook (Request)

When an inbound call is received, the server will send a `POST` request to your `DEFAULT_N8N_WEBHOOK_URL` with the following body:

```json
{
  "event": "call.started",
  "twilio_call_sid": "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "from": "+1234567890",
  "to": "+1987654321",
  "timestamp": "2025-11-04T10:00:00.000Z"
}
```

### N8N Configuration Webhook (Response)

Your n8n webhook should respond with a JSON object containing the desired call configuration:

```json
{
  "voice": "shimmer",
  "instructions": "You are a friendly virtual assistant for a retail store.",
  "static_message": "You have reached your plan call limit. Please contact support.",
  "welcome_greeting": "Thanks for calling! How can I help you shop today?",
  "webhook_url": "https://your-n8n-instance.com/webhook/call-completed",
  "metadata": { "customer_tier": "gold" }
}
```

For inbound calls, if `static_message` is returned in this webhook response (during prefetch), the server returns TwiML that says the message and hangs up instead of connecting to OpenAI.

### N8N Completion Webhook (Request)

When a call ends, the server will send a `POST` request to the `webhook_url` specified in the call's configuration:

```json
{
  "event": "call.completed",
  "twilio_call_sid": "CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "openai_conversation_id": "conv_xxxxxxxxxxxxxx",
  "from": "+1234567890",
  "to": "+1987654321",
  "direction": "inbound",
  "duration": 65,
  "status": "completed",
  "metadata": { "customer_tier": "gold" },
  "timestamp": "2025-11-04T10:01:05.000Z"
}
```
