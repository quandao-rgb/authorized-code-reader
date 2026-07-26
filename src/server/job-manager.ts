import { randomUUID } from "node:crypto";
import type { AppConfig, CodeWatcher, MailboxConfig } from "./types.js";
import { normalizeEmail } from "./config.js";
import { WatcherTimeoutError } from "./mail-watcher.js";

export const MESSAGES = {
  notFound: "Không tìm thấy email.",
  busy: "Đang có người chờ mã. Vui lòng thử lại sau.",
  timeout: "Không tìm thấy mã. Hãy thử lại.",
  error: "Không thể kiểm tra hộp thư. Hãy thử lại sau.",
} as const;

type WaitingJob = {
  status: "waiting";
  requestId: string;
  mailboxEmail: string;
  requestedAt: Date;
  expiresAt: Date;
  abortController: AbortController;
};

type QueuedJob = Omit<WaitingJob, "status"> & {
  status: "queued";
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

export type CodeJob = QueuedJob | WaitingJob | FoundJob | FinishedJob;

export type CreateJobResult =
  | { status: "not_found" }
  | { status: "duplicate" }
  | { status: "global_limit" }
  | { status: "queued"; requestId: string; expiresAt: Date }
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
  private readonly queuedByMailbox = new Map<string, string>();
  private readonly runningByRequest = new Map<string, Promise<void>>();
  private readonly cancelingByMailbox = new Map<string, Promise<void>>();
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

    const requestId = this.idFactory();
    const requestedAt = new Date(this.now());
    const expiresAt = new Date(requestedAt.getTime() + this.timeoutMs);
    const jobDetails = {
      requestId,
      mailboxEmail: mailbox.email,
      requestedAt,
      expiresAt,
      abortController: new AbortController(),
    };

    if (this.cancelingByMailbox.has(mailbox.email)) {
      if (this.queuedByMailbox.has(mailbox.email)) {
        return { status: "duplicate" };
      }

      const queuedJob: QueuedJob = {
        status: "queued",
        ...jobDetails,
      };
      this.jobs.set(requestId, queuedJob);
      this.queuedByMailbox.set(mailbox.email, requestId);
      return { status: "queued", requestId, expiresAt };
    }

    if (this.runningByRequest.size >= 5) {
      return { status: "global_limit" };
    }

    const job: WaitingJob = {
      status: "waiting",
      ...jobDetails,
    };
    this.jobs.set(requestId, job);
    this.startJob(job, mailbox);

    return { status: "waiting", requestId, expiresAt };
  }

  get(requestId: string): CodeJob | undefined {
    return this.jobs.get(requestId);
  }

  async cancel(requestId: string): Promise<boolean> {
    const job = this.jobs.get(requestId);
    if (!job) {
      return false;
    }

    if (job.status === "queued") {
      if (this.queuedByMailbox.get(job.mailboxEmail) === requestId) {
        this.queuedByMailbox.delete(job.mailboxEmail);
      }
      job.abortController.abort();
      this.jobs.delete(requestId);
      return true;
    }

    if (job.status === "waiting") {
      job.abortController.abort();
      if (this.activeByMailbox.get(job.mailboxEmail) === requestId) {
        this.activeByMailbox.delete(job.mailboxEmail);
      }
      const completion = this.runningByRequest.get(requestId) ?? Promise.resolve();
      this.cancelingByMailbox.set(job.mailboxEmail, completion);
      this.jobs.delete(requestId);

      await completion;
      if (this.cancelingByMailbox.get(job.mailboxEmail) === completion) {
        this.cancelingByMailbox.delete(job.mailboxEmail);
        this.startQueuedJob(job.mailboxEmail);
      }
      return true;
    }

    this.jobs.delete(requestId);
    return true;
  }

  shutdown(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "waiting" || job.status === "queued") {
        job.abortController.abort();
      }
    }
    this.activeByMailbox.clear();
    this.queuedByMailbox.clear();
    this.cancelingByMailbox.clear();
    this.jobs.clear();
  }

  private startJob(job: WaitingJob, mailbox: MailboxConfig): void {
    this.activeByMailbox.set(mailbox.email, job.requestId);
    const running = this.runJob(job, mailbox).finally(() => {
      this.runningByRequest.delete(job.requestId);
    });
    this.runningByRequest.set(job.requestId, running);
  }

  private startQueuedJob(mailboxEmail: string): void {
    const requestId = this.queuedByMailbox.get(mailboxEmail);
    if (!requestId) {
      return;
    }

    this.queuedByMailbox.delete(mailboxEmail);
    const queuedJob = this.jobs.get(requestId);
    const mailbox = this.config.mailboxes.find(
      (candidate) => candidate.email === mailboxEmail,
    );
    if (!queuedJob || queuedJob.status !== "queued" || !mailbox) {
      return;
    }

    if (queuedJob.expiresAt.getTime() <= this.now()) {
      this.finishJob({
        status: "timeout",
        requestId: queuedJob.requestId,
        mailboxEmail: queuedJob.mailboxEmail,
        message: MESSAGES.timeout,
      });
      return;
    }

    const waitingJob: WaitingJob = {
      ...queuedJob,
      status: "waiting",
    };
    this.jobs.set(requestId, waitingJob);
    this.startJob(waitingJob, mailbox);
  }

  private async runJob(job: WaitingJob, mailbox: MailboxConfig): Promise<void> {
    try {
      const code = await this.watcher.watch(
        mailbox,
        job.requestedAt,
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
    if (this.activeByMailbox.get(job.mailboxEmail) === job.requestId) {
      this.activeByMailbox.delete(job.mailboxEmail);
    }

    const timer = setTimeout(() => {
      this.jobs.delete(job.requestId);
    }, this.cleanupMs);
    timer.unref?.();
  }
}
