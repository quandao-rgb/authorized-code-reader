import { describe, expect, it } from "vitest";
import { EmailAttemptLimiter } from "../src/server/email-attempt-limiter.js";

describe("email attempt limiter", () => {
  it("allows six starts in a rolling ten-minute window", () => {
    const limiter = new EmailAttemptLimiter();

    for (let index = 0; index < 6; index += 1) {
      expect(limiter.canConsume("mailbox@example.com")).toBe(true);
      limiter.record("mailbox@example.com", `request-${index}`);
    }

    expect(limiter.canConsume("mailbox@example.com")).toBe(false);
  });

  it("releases only the reservation for the cancelled request", () => {
    const limiter = new EmailAttemptLimiter(2);

    limiter.record("mailbox@example.com", "first");
    limiter.record("mailbox@example.com", "handoff");
    expect(limiter.canConsume("mailbox@example.com")).toBe(false);

    expect(limiter.release("first")).toBe(true);
    expect(limiter.release("first")).toBe(false);
    expect(limiter.canConsume("mailbox@example.com")).toBe(true);
    expect(limiter.release("handoff")).toBe(true);
  });

  it("expires old reservations", () => {
    let now = 0;
    const limiter = new EmailAttemptLimiter(1, 10_000, () => now);

    limiter.record("mailbox@example.com", "first");
    expect(limiter.canConsume("mailbox@example.com")).toBe(false);

    now = 10_001;
    expect(limiter.canConsume("mailbox@example.com")).toBe(true);
    expect(limiter.release("first")).toBe(false);
  });
});
