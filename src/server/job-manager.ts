import { randomUUID } from "node:crypto";
import type { AppConfig, CodeWatcher, MailboxConfig } from "./types.js";
import { normalizeEmail } from "./config.js";
import { WatcherTimeoutError } from "./mail-watcher.js";

export const MESSAGES = {
  notFound: "Không tìm thấy email.",
  timeout: "Không tìm thấy mã. Hãy thử lại.",
  error: "Không thể kiểm tra hộp thư. Hãy thử lại sau.",
} as const;

type WaitingJob = {
  status: "waiting";
  requestId: string;
  mailboxEmail: string;
  expiresAt: Date;
  abortController: AbortController;
};

type FoundJob = {
  status: "found";
  requestId: string;
  mailboxEmail: string;
  code: string;
};

type FinishedJob = {
  status: "timeout" | "error";
  requestId: string;
  mailboxEmail: string;
  message: string;
};

export type CodeJob = WaitingJob | FoundJob | FinishedJob;

export type CreateJobResult =
  | { status: "not_found" }
  | { status: "duplicate" }
  | { status: "global_limit" }
  | { status: "waiting"; requestId: string; expiresAt: Date };

export interface JobManagerOptions {
  timeoutMs?: number;
  cleanupMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

export class CodeRequestManager {
  private readonly jobs = new Map<string, CodeJob>();
  private readonly activeByMailbox = new Map<string, string>();
  private readonly timeoutMs: number;
  private readonly cleanupMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(
    private readonly config: AppConfig,
    private readonly watcher: CodeWatcher,
    options: JobManagerOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1_000;
    this.cleanupMs = options.cleanupMs ?? 60 * 1_000;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  create(emailInput: string): CreateJobResult {
    const normalizedEmail = normalizeEmail(emailInput);
    const mailbox = this.config.mailboxes.find(
      (candidate) => candidate.email === normalizedEmail,
    );

    if (!mailbox) {
      return { status: "not_found" };
    }
    if (this.activeByMailbox.has(mailbox.email)) {
      return { status: "duplicate" };
    }
    if (this.activeByMailbox.size >= 5) {
      return { status: "global_limit" };
    }

    const requestId = this.idFactory();
    const requestedAt = new Date(this.now());
    const expiresAt = new Date(requestedAt.getTime() + this.timeoutMs);
    const job: WaitingJob = {
      status: "waiting",
      requestId,
      mailboxEmail: mailbox.email,
      expiresAt,
      abortController: new AbortController(),
    };

    this.jobs.set(requestId, job);
    this.activeByMailbox.set(mailbox.email, requestId);
    void this.runJob(job, mailbox, requestedAt);

    return { status: "waiting", requestId, expiresAt };
  }

  get(requestId: string): CodeJob | undefined {
    return this.jobs.get(requestId);
  }

  cancel(requestId: string): boolean {
    const job = this.jobs.get(requestId);
    if (!job) {
      return false;
    }

    if (job.status === "waiting") {
      job.abortController.abort();
      this.activeByMailbox.delete(job.mailboxEmail);
    }
    this.jobs.delete(requestId);
    return true;
  }

  shutdown(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "waiting") {
        job.abortController.abort();
      }
    }
    this.activeByMailbox.clear();
    this.jobs.clear();
  }

  private async runJob(
    job: WaitingJob,
    mailbox: MailboxConfig,
    requestedAt: Date,
  ): Promise<void> {
    try {
      const code = await this.watcher.watch(
        mailbox,
        requestedAt,
        job.abortController.signal,
      );
      if (!job.abortController.signal.aborted && this.jobs.has(job.requestId)) {
        this.finishJob({
          status: "found",
          requestId: job.requestId,
          mailboxEmail: job.mailboxEmail,
          code,
        });
      }
    } catch (error) {
      if (job.abortController.signal.aborted || !this.jobs.has(job.requestId)) {
        return;
      }

      if (error instanceof WatcherTimeoutError) {
        this.finishJob({
          status: "timeout",
          requestId: job.requestId,
          mailboxEmail: job.mailboxEmail,
          message: MESSAGES.timeout,
        });
      } else {
        this.finishJob({
          status: "error",
          requestId: job.requestId,
          mailboxEmail: job.mailboxEmail,
          message: MESSAGES.error,
        });
      }
    }
  }

  private finishJob(job: FoundJob | FinishedJob): void {
    this.jobs.set(job.requestId, job);
    this.activeByMailbox.delete(job.mailboxEmail);

    const timer = setTimeout(() => {
      this.jobs.delete(job.requestId);
    }, this.cleanupMs);
    timer.unref?.();
  }
}
