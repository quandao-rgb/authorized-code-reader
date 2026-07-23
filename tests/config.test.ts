import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  loadConfig,
  normalizeEmail,
  parseMailboxesJson,
} from "../src/server/config.js";
import { mailbox } from "./fixtures.js";

describe("environment validation", () => {
  it("parses and normalizes a valid configuration", () => {
    const config = loadConfig({
      MAILBOXES_JSON: JSON.stringify([
        mailbox({
          email: "  MailBox@Example.COM ",
          allowedSenders: ["LOGIN-CODE@ADMIN-SERVICE.EXAMPLE"],
        }),
      ]),
      PORT: "4100",
    });

    expect(config.port).toBe(4100);
    expect(config.mailboxes[0]?.email).toBe("mailbox@example.com");
    expect(config.mailboxes[0]?.allowedSenders[0]).toBe(
      "login-code@admin-service.example",
    );
  });

  it("rejects missing, malformed, non-TLS, and duplicate mailbox settings", () => {
    expect(() => parseMailboxesJson(undefined)).toThrow(ConfigurationError);
    expect(() => parseMailboxesJson("{not-json")).toThrow(ConfigurationError);

    const insecure = mailbox();
    (insecure.imap as { secure: boolean }).secure = false;
    expect(() => parseMailboxesJson(JSON.stringify([insecure]))).toThrow(
      ConfigurationError,
    );

    expect(() => parseMailboxesJson(JSON.stringify([mailbox(), mailbox()]))).toThrow(
      ConfigurationError,
    );
  });
});

describe("email normalization", () => {
  it("trims whitespace and lowercases the address", () => {
    expect(normalizeEmail("  Customer@Example.COM ")).toBe("customer@example.com");
  });
});
