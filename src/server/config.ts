import { z } from "zod";
import type { AppConfig, MailboxConfig } from "./types.js";

export class ConfigurationError extends Error {
  constructor() {
    super("Invalid application configuration.");
    this.name = "ConfigurationError";
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

const emailSchema = z
  .string()
  .trim()
  .max(254)
  .email()
  .transform((value) => value.toLowerCase());

const hostnameSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine((value) => !value.includes("://"), "Use a hostname, not a URL.");

export const mailboxSchema = z
  .object({
    email: emailSchema,
    imap: z
      .object({
        host: hostnameSchema,
        port: z.number().int().min(1).max(65_535),
        secure: z.literal(true),
        username: z.string().trim().min(1).max(320),
        password: z.string().min(1).max(1_024),
      })
      .strict(),
    allowedSenders: z.array(emailSchema).max(100).default([]),
    allowedSenderDomains: z
      .array(hostnameSchema.transform((value) => value.toLowerCase()))
      .max(100)
      .default([]),
    loginKeywords: z
      .array(
        z
          .string()
          .trim()
          .min(2)
          .max(100)
          .transform((value) => value.toLowerCase()),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (mailbox) =>
      mailbox.allowedSenders.length > 0 || mailbox.allowedSenderDomains.length > 0,
    "At least one sender allowlist entry is required.",
  );

const mailboxesSchema = z
  .array(mailboxSchema)
  .max(100)
  .superRefine((mailboxes, context) => {
    const seen = new Set<string>();
    for (const [index, mailbox] of mailboxes.entries()) {
      if (seen.has(mailbox.email)) {
        context.addIssue({
          code: "custom",
          message: "Duplicate mailbox.",
          path: [index, "email"],
        });
      }
      seen.add(mailbox.email);
    }
  });

export function parseMailboxesJson(value: string | undefined): MailboxConfig[] {
  if (!value) {
    throw new ConfigurationError();
  }

  try {
    const parsed: unknown = JSON.parse(value);
    const result = mailboxesSchema.safeParse(parsed);
    if (!result.success) {
      throw new ConfigurationError();
    }
    return result.data;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError();
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const portResult = z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .safeParse(environment.PORT ?? 3001);

  if (!portResult.success) {
    throw new ConfigurationError();
  }

  return {
    mailboxes: parseMailboxesJson(environment.MAILBOXES_JSON),
    port: portResult.data,
  };
}
