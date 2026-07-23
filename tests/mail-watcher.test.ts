import { describe, expect, it, vi } from "vitest";
import {
  MailWatcher,
  WatcherTimeoutError,
  type MailboxClientFactory,
} from "../src/server/mail-watcher.js";
import type { InboundMessage, MailboxClient } from "../src/server/types.js";
import { mailbox } from "./fixtures.js";

class FakeClient implements MailboxClient {
  connected = 0;
  closed = 0;
  openUid = 10;
  messages: InboundMessage[] = [];
  connectError: Error | null = null;

  async connect(): Promise<void> {
    this.connected += 1;
    if (this.connectError) {
      throw this.connectError;
    }
  }

  async openInbox(): Promise<number> {
    return this.openUid;
  }

  async listNewMessages(minimumUid: number): Promise<InboundMessage[]> {
    return this.messages.filter((message) => message.uid >= minimumUid);
  }

  async waitForNewMessage(signal: AbortSignal, timeoutMs: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(timeoutMs, 5_000));
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    uid: 10,
    receivedAt: new Date("2026-01-01T00:00:01.000Z"),
    from: ["login-code@admin-service.example"],
    subject: "Login",
    text: "Your login code is 4826.",
    html: "",
    ...overrides,
  };
}

describe("MailWatcher", () => {
  it("returns a code from a newly arrived, authorized message", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.messages = [message()];
    const watcher = new MailWatcher({
      timeoutMs: 300_000,
      clientFactory: () => client,
      now: Date.now,
    });

    const resultPromise = watcher.watch(
      mailbox(),
      new Date("2026-01-01T00:00:00.000Z"),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(resultPromise).resolves.toBe("4826");
    expect(client.closed).toBe(1);
    vi.useRealTimers();
  });

  it("ignores messages before the request and disallowed senders", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    client.messages = [
      message({
        uid: 10,
        receivedAt: new Date("2025-12-31T23:59:59.000Z"),
      }),
      message({
        uid: 11,
        from: ["attacker@example.net"],
        text: "Your login code is 9999.",
      }),
    ];
    const watcher = new MailWatcher({
      timeoutMs: 10_000,
      clientFactory: () => client,
      now: Date.now,
    });

    const resultPromise = watcher.watch(
      mailbox(),
      new Date("2026-01-01T00:00:00.000Z"),
      new AbortController().signal,
    );
    const expectation = expect(resultPromise).rejects.toBeInstanceOf(WatcherTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await expectation;
    expect(client.closed).toBe(1);
    vi.useRealTimers();
  });

  it("times out after five minutes using fake timers", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const watcher = new MailWatcher({
      timeoutMs: 5 * 60 * 1_000,
      clientFactory: () => client,
      now: Date.now,
    });

    const resultPromise = watcher.watch(
      mailbox(),
      new Date(Date.now()),
      new AbortController().signal,
    );
    const expectation = expect(resultPromise).rejects.toBeInstanceOf(WatcherTimeoutError);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    await expectation;
    expect(client.closed).toBe(1);
    vi.useRealTimers();
  });

  it("closes the connection when cancelled", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const controller = new AbortController();
    const watcher = new MailWatcher({
      clientFactory: () => client,
      now: Date.now,
    });

    const resultPromise = watcher.watch(
      mailbox(),
      new Date(Date.now()),
      controller.signal,
    );
    controller.abort();
    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(client.closed).toBe(1);
    vi.useRealTimers();
  });

  it("retries one temporary connection failure and then succeeds", async () => {
    vi.useFakeTimers();
    const first = new FakeClient();
    first.connectError = new Error("temporary");
    const second = new FakeClient();
    second.messages = [message()];
    const clients = [first, second];
    const factory: MailboxClientFactory = () => clients.shift()!;
    const watcher = new MailWatcher({
      clientFactory: factory,
      now: Date.now,
    });

    const resultPromise = watcher.watch(
      mailbox(),
      new Date("2026-01-01T00:00:00.000Z"),
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(resultPromise).resolves.toBe("4826");
    expect(first.closed).toBe(1);
    expect(second.closed).toBe(1);
    vi.useRealTimers();
  });
});
