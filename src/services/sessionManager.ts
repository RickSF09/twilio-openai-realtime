import { CallSession, CallConfig } from '../types';
import { logger } from '../utils/logger';

export class SessionManager {
  private sessions: Map<string, CallSession> = new Map();

  /**
   * Create a new call session
   */
  createSession(
    twilioCallSid: string,
    config: CallConfig,
    direction: 'inbound' | 'outbound',
    from?: string,
    to?: string
  ): CallSession {
    const session: CallSession = {
      twilioCallSid,
      config,
      direction,
      from,
      to,
      startTime: new Date(),
    };

    this.sessions.set(twilioCallSid, session);
    logger.info('Call session created', { 
      twilioCallSid, 
      direction,
      from,
      to 
    });

    return session;
  }

  /**
   * Get a call session by Twilio Call SID
   */
  getSession(twilioCallSid: string): CallSession | undefined {
    return this.sessions.get(twilioCallSid);
  }

  /**
   * Update OpenAI conversation ID for a session
   */
  updateOpenAIConversationId(
    twilioCallSid: string,
    conversationId: string
  ): void {
    const session = this.sessions.get(twilioCallSid);
    if (session) {
      session.openaiConversationId = conversationId;
      logger.info('OpenAI conversation ID updated', { 
        twilioCallSid, 
        conversationId 
      });
    }
  }

  /**
   * End a call session
   */
  endSession(twilioCallSid: string): CallSession | undefined {
    const session = this.sessions.get(twilioCallSid);
    if (session) {
      session.endTime = new Date();
      logger.info('Call session ended', { 
        twilioCallSid,
        duration: session.endTime.getTime() - session.startTime.getTime()
      });
    }
    return session;
  }

  /**
   * Remove a session from memory
   */
  removeSession(twilioCallSid: string): void {
    this.sessions.delete(twilioCallSid);
    logger.debug('Call session removed from memory', { twilioCallSid });
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): CallSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}

export const sessionManager = new SessionManager();
