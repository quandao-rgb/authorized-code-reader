export class EmailAttemptLimiter {
  private readonly attempts = new Map<
    string,
    Array<{ requestId: string; timestamp: number }>
  >();
  private readonly emailByRequest = new Map<string, string>();

  constructor(
    private readonly maximum = 6,
    private readonly windowMs = 10 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  canConsume(email: string): boolean {
    const currentTime = this.now();
    return this.prune(email, currentTime).length < this.maximum;
  }

  record(email: string, requestId: string): void {
    const currentTime = this.now();
    const recent = this.prune(email, currentTime);
    recent.push({ requestId, timestamp: currentTime });
    this.attempts.set(email, recent);
    this.emailByRequest.set(requestId, email);
  }

  release(requestId: string): boolean {
    const email = this.emailByRequest.get(requestId);
    if (!email) {
      return false;
    }

    this.emailByRequest.delete(requestId);
    const remaining = (this.attempts.get(email) ?? []).filter(
      (attempt) => attempt.requestId !== requestId,
    );
    if (remaining.length === 0) {
      this.attempts.delete(email);
    } else {
      this.attempts.set(email, remaining);
    }
    return true;
  }

  private prune(
    email: string,
    currentTime: number,
  ): Array<{ requestId: string; timestamp: number }> {
    const existing = this.attempts.get(email) ?? [];
    const recent = existing.filter(
      (attempt) => attempt.timestamp > currentTime - this.windowMs,
    );

    for (const attempt of existing) {
      if (!recent.includes(attempt)) {
        this.emailByRequest.delete(attempt.requestId);
      }
    }

    if (recent.length === 0) {
      this.attempts.delete(email);
    } else {
      this.attempts.set(email, recent);
    }
    return recent;
  }
}
