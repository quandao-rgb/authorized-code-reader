import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { CodeRequestManager } from "../src/server/job-manager.js";
import type { CodeWatcher } from "../src/server/types.js";
import { appConfig } from "./fixtures.js";

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

  it("returns a generic error for a duplicate active request", async () => {
    const { app } = testApp();
    await request(app).post("/api/code-requests").send({ email: "mailbox@example.com" });
    const duplicate = await request(app)
      .post("/api/code-requests")
      .send({ email: "mailbox@example.com" });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toEqual({
      status: "error",
      message: "Không thể kiểm tra hộp thư. Hãy thử lại sau.",
    });
  });
});
