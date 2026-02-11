class CompletionTracker {
  private completedCallSids = new Set<string>();
  private processingCallSids = new Set<string>();
  private static readonly COMPLETED_TTL_MS = 5 * 60 * 1000;

  begin(callSid: string): boolean {
    if (this.completedCallSids.has(callSid) || this.processingCallSids.has(callSid)) {
      return false;
    }

    this.processingCallSids.add(callSid);
    return true;
  }

  complete(callSid: string): void {
    this.completedCallSids.add(callSid);
    setTimeout(() => this.completedCallSids.delete(callSid), CompletionTracker.COMPLETED_TTL_MS);
  }

  endAttempt(callSid: string): void {
    this.processingCallSids.delete(callSid);
  }
}

export const completionTracker = new CompletionTracker();
