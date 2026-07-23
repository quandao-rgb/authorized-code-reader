export class EmailAttemptLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maximum = 3,
    private readonly windowMs = 10 * 60 * 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  consume(email: string): boolean {
    const currentTime = this.now();
    const recent = (this.attempts.get(email) ?? []).filter(
      (timestamp) => timestamp > currentTime - this.windowMs,
    );
    if (recent.length >= this.maximum) {
      this.attempts.set(email, recent);
      return false;
    }
    recent.push(currentTime);
    this.attempts.set(email, recent);
    return true;
  }
}
