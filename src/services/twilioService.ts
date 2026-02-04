import twilio from 'twilio';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

export class TwilioService {
  private client: twilio.Twilio;

  constructor() {
    this.client = twilio(
      config.twilio.accountSid,
      config.twilio.authToken
    );
  }

  /**
   * Initiate an outbound call yes
   */
  async makeOutboundCall(
    to: string,
    from: string | undefined,
    websocketUrl: string,
    tempId: string
  ): Promise<{ callSid: string; status: string }> {
    try {
      const fromNumber = from || config.twilio.phoneNumber;

      logger.info('Initiating outbound call', { to, from: fromNumber });

      const call = await this.client.calls.create({
        to,
        from: fromNumber,
        twiml: this.generateOutboundTwiML(websocketUrl, tempId),
        // record: true, // Disable auto-record to allow manual dual-channel start
        // recordingChannels: 'dual',
      });

      logger.info('Outbound call initiated', { 
        callSid: call.sid, 
        status: call.status 
      });

      return {
        callSid: call.sid,
        status: call.status,
      };
    } catch (error) {
      logger.error('Failed to initiate outbound call', error);
      throw error;
    }
  }

  /**
   * Generate TwiML for connecting to Media Stream
   */
  generateTwiML(websocketUrl: string): string {
    const twiml = new twilio.twiml.VoiceResponse();
    const connect = twiml.connect();
    connect.stream({ url: websocketUrl });
    
    return twiml.toString();
  }

  /**
   * Generate TwiML for outbound calls with custom parameters
   */
  generateOutboundTwiML(websocketUrl: string, tempId: string): string {
    const twiml = new twilio.twiml.VoiceResponse();
    const connect = twiml.connect();
    const stream = connect.stream({ url: websocketUrl });
    // Attach custom parameters so we can recover tempId/direction from 'start' event
    // Twilio will surface these under start.customParameters
    // @ts-ignore TwiML builder supports parameter on <Stream>
    stream.parameter({ name: 'tempId', value: tempId });
    // @ts-ignore
    stream.parameter({ name: 'direction', value: 'outbound' });
    return twiml.toString();
  }

  /**
   * Generate TwiML with greeting for inbound calls
   */
  generateInboundTwiML(websocketUrl: string, callSid: string, from: string, to: string): string {
    const twiml = new twilio.twiml.VoiceResponse();
    
    // Connect to Media Stream immediately
    // Note: Recording for inbound calls is started via API in the route handler
    const connect = twiml.connect();
    const stream = connect.stream({ url: websocketUrl });
    
    // Attach custom parameters so we can identify this as inbound
    // Twilio will surface these under start.customParameters
    // @ts-ignore TwiML builder supports parameter on <Stream>
    stream.parameter({ name: 'callSid', value: callSid });
    // @ts-ignore
    stream.parameter({ name: 'direction', value: 'inbound' });
    // @ts-ignore
    stream.parameter({ name: 'from', value: from });
    // @ts-ignore
    stream.parameter({ name: 'to', value: to });
    
    return twiml.toString();
  }

  /**
   * Start recording an active call with retry logic
   */
  async startRecording(callSid: string, maxRetries: number = 3): Promise<void> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Small initial delay on first attempt to allow call to transition to 'in-progress' status
        // The 'start' event from Twilio Media Stream fires when the stream connects,
        // but the call might still be transitioning from 'ringing' to 'in-progress'
        if (attempt === 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

        // First, check the call status to ensure it's in a recordable state
        const call = await this.client.calls(callSid).fetch();
        
        if (call.status === 'completed' || call.status === 'busy' || call.status === 'no-answer' || call.status === 'failed' || call.status === 'canceled') {
          logger.warn('Cannot start recording - call is not in progress', { 
            callSid, 
            status: call.status,
            attempt: attempt + 1 
          });
          return; // Call has ended, no point retrying
        }

        if (call.status !== 'in-progress' && call.status !== 'ringing') {
          // If call is queued or initiating, wait a bit and retry
          if (attempt < maxRetries - 1) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff, max 5s
            logger.debug('Call not ready for recording, retrying', { 
              callSid, 
              status: call.status, 
              attempt: attempt + 1,
              delayMs: delay 
            });
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }

        // Start recording on an active call using the Recordings API
        const recording = await this.client.calls(callSid).recordings.create({
          recordingChannels: 'dual', // Record both sides of the call
          recordingStatusCallback: undefined, // You can add a webhook URL here if needed
          recordingStatusCallbackMethod: 'POST',
        });
        
        // Verify recording was created by fetching it
        try {
          const verifyRecording = await this.client.recordings(recording.sid).fetch();
          logger.info('Call recording started and verified', { 
            callSid, 
            recordingSid: recording.sid,
            recordingStatus: verifyRecording.status,
            callStatus: call.status,
            attempt: attempt + 1 
          });
        } catch (verifyError) {
          logger.warn('Recording created but verification failed', {
            callSid,
            recordingSid: recording.sid,
            error: verifyError
          });
        }
        
        return; // Success, exit retry loop
      } catch (error: any) {
        const errorMessage = error?.message || String(error);
        const errorCode = error?.code || error?.status || 'unknown';
        
        // Check if it's a terminal error (call doesn't exist, already completed, etc.)
        if (errorCode === 20404 || errorCode === 404) {
          logger.error('Call not found - cannot start recording', { callSid, errorCode });
          return; // Don't retry if call doesn't exist
        }

        if (errorCode === 21211 || errorMessage?.includes('not in a state that allows recording')) {
          logger.warn('Call not in recordable state', { 
            callSid, 
            errorCode, 
            errorMessage,
            attempt: attempt + 1 
          });
          if (attempt < maxRetries - 1) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }

        // Log error but continue retrying unless it's the last attempt
        logger.error('Failed to start call recording', { 
          callSid, 
          errorCode,
          errorMessage,
          attempt: attempt + 1,
          maxRetries,
          willRetry: attempt < maxRetries - 1
        });

        if (attempt < maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          logger.error('Failed to start recording after all retries', { callSid, maxRetries });
        }
      }
    }
    // Don't throw - recording failure shouldn't break the call
  }
}

export const twilioService = new TwilioService();
