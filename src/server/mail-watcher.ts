import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import {
  extractAuthorizedLoginCode,
  isAllowedSender,
} from "./extract-authorized-login-code.js";
import type {
  CodeWatcher,
  InboundMessage,
  MailboxClient,
  MailboxConfig,
} from "./types.js";

export class WatcherTimeoutError extends Error {
  constructor() {
    super("Mailbox watch timed out.");
    this.name = "WatcherTimeoutError";
  }
}

function abortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

export class ImapMailboxClient implements MailboxClient {
  private readonly client: ImapFlow;

  constructor(mailbox: MailboxConfig) {
    this.client = new ImapFlow({
      host: mailbox.imap.host,
      port: mailbox.imap.port,
      secure: true,
      auth: {
        user: mailbox.imap.username,
        pass: mailbox.imap.password,
      },
      tls: {
        rejectUnauthorized: true,
      },
      logger: false,
      disableAutoIdle: false,
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async openInbox(): Promise<number> {
    const mailbox = await this.client.mailboxOpen("INBOX", { readOnly: true });
    return mailbox.uidNext;
  }

  async listNewMessages(minimumUid: number): Promise<InboundMessage[]> {
    const output: InboundMessage[] = [];

    for await (const message of this.client.fetch(
      `${minimumUid}:*`,
      {
        uid: true,
        envelope: true,
        internalDate: true,
        source: true,
      },
      { uid: true },
    )) {
      if (message.uid < minimumUid || !message.source) {
        continue;
      }

      const parsed = await simpleParser(message.source, {
        skipImageLinks: true,
        skipHtmlToText: false,
      });
      const from =
        parsed.from?.value
          .map((address) => address.address)
          .filter((address): address is string => Boolean(address)) ?? [];

      output.push({
        uid: message.uid,
        receivedAt: message.internalDate
          ? new Date(message.internalDate)
          : (parsed.date ?? new Date(0)),
        from,
        subject: parsed.subject ?? "",
        text: parsed.text ?? "",
        html: typeof parsed.html === "string" ? parsed.html : "",
      });
    }

    return output;
  }

  async waitForNewMessage(signal: AbortSignal, timeoutMs: number): Promise<void> {
    if (signal.aborted) {
      throw abortError();
    }

    await new Promise<void>((resolve, reject) => {
      const waitMs = Math.min(5_000, Math.max(1, timeoutMs));
      const timer = setTimeout(finish, waitMs);

      const onExists = (): void => finish();
      const onAbort = (): void => finish(abortError());

      const cleanup = (): void => {
        clearTimeout(timer);
        this.client.off("exists", onExists);
        signal.removeEventListener("abort", onAbort);
      };

      function finish(error?: Error): void {
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      }

      this.client.once("exists", onExists);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async close(): Promise<void> {
    try {
      if (this.client.usable) {
        await this.client.logout();
      } else {
        this.client.close();
      }
    } catch {
      this.client.close();
    }
  }
}

export type MailboxClientFactory = (mailbox: MailboxConfig) => MailboxClient;

export interface MailWatcherOptions {
  timeoutMs?: number;
  clientFactory?: MailboxClientFactory;
  now?: () => number;
}

export class MailWatcher implements CodeWatcher {
  private readonly timeoutMs: number;
  private readonly clientFactory: MailboxClientFactory;
  private readonly now: () => number;

  constructor(options: MailWatcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000;
    this.clientFactory =
      options.clientFactory ?? ((mailbox) => new ImapMailboxClient(mailbox));
    this.now = options.now ?? Date.now;
  }

  async watch(
    mailbox: MailboxConfig,
    requestedAt: Date,
    signal: AbortSignal,
  ): Promise<string> {
    const deadline = this.now() + this.timeoutMs;
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (signal.aborted) {
        throw abortError();
      }

      const client = this.clientFactory(mailbox);
      try {
        return await this.watchConnection(client, mailbox, requestedAt, deadline, signal);
      } catch (error) {
        if (error instanceof WatcherTimeoutError || signal.aborted) {
          throw error;
        }
        lastError = error;
        if (attempt === 1 || this.now() >= deadline) {
          throw error;
        }
      } finally {
        await client.close();
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Mailbox check failed.");
  }

  private async watchConnection(
    client: MailboxClient,
    mailbox: MailboxConfig,
    requestedAt: Date,
    deadline: number,
    signal: AbortSignal,
  ): Promise<string> {
    await client.connect();
    let nextUid = await client.openInbox();

    while (this.now() < deadline) {
      if (signal.aborted) {
        throw abortError();
      }

      await client.waitForNewMessage(signal, deadline - this.now());
      const messages = (await client.listNewMessages(nextUid)).sort(
        (left, right) => left.uid - right.uid,
      );

      for (const message of messages) {
        nextUid = Math.max(nextUid, message.uid + 1);
        if (message.receivedAt.getTime() < requestedAt.getTime()) {
          continue;
        }
        if (
          !isAllowedSender(
            message.from,
            mailbox.allowedSenders,
            mailbox.allowedSenderDomains,
          )
        ) {
          continue;
        }

        const code = extractAuthorizedLoginCode({
          subject: message.subject,
          text: message.text,
          html: message.html,
          loginKeywords: mailbox.loginKeywords,
        });
        if (code) {
          return code;
        }
      }
    }

    throw new WatcherTimeoutError();
  }
}
