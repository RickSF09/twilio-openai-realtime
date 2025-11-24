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
   * Start recording an active call
   */
  async startRecording(callSid: string): Promise<void> {
    try {
      // Start recording on an active call using the Recordings API
      // Note: This requires the call to be in progress
      await this.client.calls(callSid).recordings.create({
        recordingChannels: 'dual', // Record both sides of the call
        recordingStatusCallback: undefined, // You can add a webhook URL here if needed
        recordingStatusCallbackMethod: 'POST',
      });
      logger.info('Call recording started', { callSid });
    } catch (error) {
      logger.error('Failed to start call recording', error);
      // Don't throw - recording failure shouldn't break the call
    }
  }
}

export const twilioService = new TwilioService();
