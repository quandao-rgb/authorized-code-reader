import { describe, expect, it, vi } from "vitest";
import { CodeRequestManager, MESSAGES } from "../src/server/job-manager.js";
import { WatcherTimeoutError } from "../src/server/mail-watcher.js";
import type { CodeWatcher, MailboxConfig } from "../src/server/types.js";
import { appConfig, mailbox } from "./fixtures.js";

function pendingWatcher(): {
  watcher: CodeWatcher;
  signals: AbortSignal[];
} {
  const signals: AbortSignal[] = [];
  return {
    signals,
    watcher: {
      watch: (_mailbox, _date, signal) => {
        signals.push(signal);
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("code request manager", () => {
  it("returns not_found for an unknown email", () => {
    const manager = new CodeRequestManager(appConfig(), pendingWatcher().watcher);
    expect(manager.create("unknown@example.com")).toEqual({ status: "not_found" });
  });

  it("normalizes a configured email and creates a waiting job", () => {
    const pending = pendingWatcher();
    const manager = new CodeRequestManager(appConfig(), pending.watcher, {
      idFactory: () => "request-1",
      now: () => 1_000,
    });

    expect(manager.create("  MAILBOX@EXAMPLE.COM ")).toEqual({
      status: "waiting",
      requestId: "request-1",
      expiresAt: new Date(301_000),
    });
  });

  it("rejects a duplicate active request for one mailbox", () => {
    const manager = new CodeRequestManager(appConfig(), pendingWatcher().watcher);
    expect(manager.create("mailbox@example.com").status).toBe("waiting");
    expect(manager.create("mailbox@example.com")).toEqual({ status: "duplicate" });
  });

  it("allows no more than five active watchers globally", () => {
    const mailboxes: MailboxConfig[] = Array.from({ length: 6 }, (_, index) =>
      mailbox({
        email: `mailbox-${index}@example.com`,
        imap: {
          ...mailbox().imap,
          username: `mailbox-${index}@example.com`,
        },
      }),
    );
    const manager = new CodeRequestManager(
      appConfig(mailboxes),
      pendingWatcher().watcher,
    );

    for (let index = 0; index < 5; index += 1) {
      expect(manager.create(`mailbox-${index}@example.com`).status).toBe("waiting");
    }
    expect(manager.create("mailbox-5@example.com")).toEqual({
      status: "global_limit",
    });
  });

  it("cancels a request and waits for its watcher to stop", async () => {
    const pending = pendingWatcher();
    const manager = new CodeRequestManager(appConfig(), pending.watcher, {
      idFactory: () => "cancel-me",
    });

    manager.create("mailbox@example.com");
    await expect(manager.cancel("cancel-me")).resolves.toBe(true);
    expect(pending.signals[0]?.aborted).toBe(true);
    expect(manager.get("cancel-me")).toBeUndefined();
  });

  it("queues one handoff request until the cancelled watcher has stopped", async () => {
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const signals: AbortSignal[] = [];
    const watcher: CodeWatcher = {
      watch: (_mailbox, _date, signal) => {
        signals.push(signal);
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const finishClose = async (): Promise<void> => {
                if (signals.length === 1) {
                  await closeGate;
                }
                reject(new DOMException("Aborted", "AbortError"));
              };
              void finishClose();
            },
            { once: true },
          );
        });
      },
    };
    const requestIds = ["first", "handoff"];
    const manager = new CodeRequestManager(appConfig(), watcher, {
      idFactory: () => requestIds.shift() ?? "unexpected",
    });

    expect(manager.create("mailbox@example.com").status).toBe("waiting");
    const cancellation = manager.cancel("first");
    expect(signals[0]?.aborted).toBe(true);

    expect(manager.create("mailbox@example.com")).toMatchObject({
      status: "queued",
      requestId: "handoff",
    });
    expect(manager.get("handoff")?.status).toBe("queued");
    expect(manager.create("mailbox@example.com")).toEqual({ status: "duplicate" });
    expect(signals).toHaveLength(1);

    releaseClose?.();
    await cancellation;
    await flushPromises();

    expect(manager.get("handoff")?.status).toBe("waiting");
    expect(signals).toHaveLength(2);
    await manager.cancel("handoff");
  });

  it("records successful results and removes the code after 60 seconds", async () => {
    vi.useFakeTimers();
    const watcher: CodeWatcher = {
      watch: async () => "4826",
    };
    const manager = new CodeRequestManager(appConfig(), watcher, {
      idFactory: () => "success",
      cleanupMs: 60_000,
    });

    manager.create("mailbox@example.com");
    await flushPromises();
    expect(manager.get("success")).toMatchObject({ status: "found", code: "4826" });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.get("success")).toBeUndefined();
    vi.useRealTimers();
  });

  it("records timeout and connection-failure states without exposing details", async () => {
    const timeoutManager = new CodeRequestManager(
      appConfig(),
      { watch: async () => Promise.reject(new WatcherTimeoutError()) },
      { idFactory: () => "timeout" },
    );
    timeoutManager.create("mailbox@example.com");
    await flushPromises();
    expect(timeoutManager.get("timeout")).toMatchObject({
      status: "timeout",
      message: MESSAGES.timeout,
    });

    const errorManager = new CodeRequestManager(
      appConfig(),
      { watch: async () => Promise.reject(new Error("secret server detail")) },
      { idFactory: () => "error" },
    );
    errorManager.create("mailbox@example.com");
    await flushPromises();
    expect(errorManager.get("error")).toMatchObject({
      status: "error",
      message: MESSAGES.error,
    });
  });
});
