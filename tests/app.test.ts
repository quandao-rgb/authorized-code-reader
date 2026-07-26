import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { EmailAttemptLimiter } from "../src/server/email-attempt-limiter.js";
import { CodeRequestManager } from "../src/server/job-manager.js";
import type { CodeWatcher } from "../src/server/types.js";
import { appConfig, mailbox } from "./fixtures.js";

const watcher: CodeWatcher = {
  watch: (_mailbox, _date, signal) =>
    new Promise<string>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    }),
};

function testApp() {
  const manager = new CodeRequestManager(appConfig(), watcher, {
    idFactory: () => "00000000-0000-4000-8000-000000000001",
  });
  return { manager, app: createApp({ manager, disableIpRateLimit: true }) };
}

describe("code request API", () => {
  it("reports a cache-disabled health check", async () => {
    const { app } = testApp();
    const response = await request(app).get("/api/health");

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ status: "ok" });
  });

  it("returns the documented unknown-email response with no-store", async () => {
    const { app } = testApp();
    const response = await request(app)
      .post("/api/code-requests")
      .send({ email: "unknown@example.com" });

    expect(response.status).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      status: "not_found",
      message: "Không tìm thấy email.",
    });
  });

  it("creates, reads, and cancels a configured request", async () => {
    const { app } = testApp();
    const created = await request(app)
      .post("/api/code-requests")
      .send({ email: "  MAILBOX@example.com " });

    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({
      status: "waiting",
      requestId: "00000000-0000-4000-8000-000000000001",
    });

    const status = await request(app).get(
      "/api/code-requests/00000000-0000-4000-8000-000000000001",
    );
    expect(status.status).toBe(200);
    expect(status.headers["cache-control"]).toBe("no-store");
    expect(status.body.status).toBe("waiting");

    const cancelled = await request(app).delete(
      "/api/code-requests/00000000-0000-4000-8000-000000000001",
    );
    expect(cancelled.status).toBe(204);
    expect(cancelled.headers["cache-control"]).toBe("no-store");
  });

  it("rejects malformed and oversized email input", async () => {
    const { app } = testApp();
    expect(
      (await request(app).post("/api/code-requests").send({ email: "not-email" })).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/code-requests")
          .send({ email: `${"a".repeat(255)}@example.com` })
      ).status,
    ).toBe(400);
  });

  it("returns a clear busy response for a duplicate active request", async () => {
    const { app } = testApp();
    await request(app).post("/api/code-requests").send({ email: "mailbox@example.com" });
    const duplicate = await request(app)
      .post("/api/code-requests")
      .send({ email: "mailbox@example.com" });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      status: "busy",
      message: "Đang có người chờ mã. Vui lòng thử lại sau.",
    });
  });

  it("does not consume an email attempt when the global watcher limit rejects it", async () => {
    const mailboxes = Array.from({ length: 6 }, (_, index) =>
      mailbox({
        email: `mailbox-${index}@example.com`,
        imap: {
          ...mailbox().imap,
          username: `mailbox-${index}@example.com`,
        },
      }),
    );
    const requestIds = [
      "active-0",
      "active-1",
      "active-2",
      "active-3",
      "active-4",
      "rejected",
      "accepted",
    ];
    const manager = new CodeRequestManager(appConfig(mailboxes), watcher, {
      idFactory: () => requestIds.shift() ?? "unexpected",
    });
    const app = createApp({
      manager,
      emailLimiter: new EmailAttemptLimiter(1),
      disableIpRateLimit: true,
    });

    for (let index = 0; index < 5; index += 1) {
      expect(manager.create(`mailbox-${index}@example.com`).status).toBe("waiting");
    }

    await request(app)
      .post("/api/code-requests")
      .send({ email: "mailbox-5@example.com" })
      .expect(503);

    await manager.cancel("active-0");
    await request(app)
      .post("/api/code-requests")
      .send({ email: "mailbox-5@example.com" })
      .expect(202);
    await request(app).delete("/api/code-requests/accepted").expect(204);
    manager.shutdown();
  });

  it("allows the same mailbox immediately after confirmed cancellation", async () => {
    const requestIds = ["first", "second"];
    const manager = new CodeRequestManager(appConfig(), watcher, {
      idFactory: () => requestIds.shift() ?? "unexpected",
    });
    const app = createApp({
      manager,
      emailLimiter: new EmailAttemptLimiter(1),
      disableIpRateLimit: true,
    });

    await request(app)
      .post("/api/code-requests")
      .send({ email: "mailbox@example.com" })
      .expect(202);

    const limited = await request(app)
      .post("/api/code-requests")
      .send({ email: "mailbox@example.com" });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({
      status: "rate_limited",
      message: "Bạn thao tác quá nhanh. Vui lòng thử lại sau.",
    });

    await request(app).delete("/api/code-requests/first").expect(204);

    const second = await request(app)
      .post("/api/code-requests")
      .send({ email: "mailbox@example.com" });
    expect(second.status).toBe(202);
    expect(second.body.requestId).toBe("second");
    await request(app).delete("/api/code-requests/second").expect(204);
  });

  it("trusts Render's single proxy hop for per-client IP limiting", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app } = testApp();

    await request(app)
      .post("/api/code-requests")
      .set("X-Forwarded-For", "203.0.113.10")
      .send({ email: "unknown@example.com" })
      .expect(404);

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("queues a handoff request while cancellation closes the previous watcher", async () => {
    let releaseClose: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let cancellationStarted: (() => void) | undefined;
    const cancellationSignal = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });
    let watchCount = 0;
    const handoffWatcher: CodeWatcher = {
      watch: (_mailbox, _date, signal) => {
        watchCount += 1;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const finishClose = async (): Promise<void> => {
                if (watchCount === 1) {
                  cancellationStarted?.();
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
    const manager = new CodeRequestManager(appConfig(), handoffWatcher, {
      idFactory: () => requestIds.shift() ?? "unexpected",
    });
    const app = createApp({ manager, disableIpRateLimit: true });

    const first = await request(app)
      .post("/api/code-requests")
      .send({ email: "mailbox@example.com" });
    const cancellation = request(app)
      .delete(`/api/code-requests/${first.body.requestId as string}`)
      .then((response) => response);
    await cancellationSignal;

    const handoff = await request(app)
      .post("/api/code-requests")
      .send({ email: "mailbox@example.com" });
    expect(handoff.status).toBe(202);
    expect(handoff.body).toMatchObject({
      status: "queued",
      requestId: "handoff",
    });

    releaseClose?.();
    expect((await cancellation).status).toBe(204);
    expect((await request(app).get("/api/code-requests/handoff")).body.status).toBe(
      "waiting",
    );
    await request(app).delete("/api/code-requests/handoff");
  });
});
