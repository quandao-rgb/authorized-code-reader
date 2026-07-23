import type { AppConfig, MailboxConfig } from "../src/server/types.js";

export function mailbox(overrides: Partial<MailboxConfig> = {}): MailboxConfig {
  return {
    email: "mailbox@example.com",
    imap: {
      host: "imap.example.com",
      port: 993,
      secure: true,
      username: "mailbox@example.com",
      password: "test-only-password",
    },
    allowedSenders: ["login-code@admin-service.example"],
    allowedSenderDomains: ["admin-service.example"],
    loginKeywords: ["login code", "verification code", "mã đăng nhập", "mã xác minh"],
    ...overrides,
  };
}

export function appConfig(mailboxes: MailboxConfig[] = [mailbox()]): AppConfig {
  return { mailboxes, port: 3001 };
}
