import { describe, expect, it } from "vitest";
import { redactSensitive } from "../src/server/logger.js";

describe("sensitive-data redaction", () => {
  it("redacts credentials and message content recursively", () => {
    expect(
      redactSensitive({
        email: "mailbox@example.com",
        password: "secret-password",
        nested: {
          oauthToken: "secret-token",
          subject: "Private subject",
          body: "Your code is 1234",
        },
      }),
    ).toEqual({
      email: "mailbox@example.com",
      password: "[REDACTED]",
      nested: {
        oauthToken: "[REDACTED]",
        subject: "[REDACTED]",
        body: "[REDACTED]",
      },
    });
  });
});
