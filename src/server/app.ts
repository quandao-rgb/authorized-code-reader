import fs from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import { normalizeEmail } from "./config.js";
import { EmailAttemptLimiter } from "./email-attempt-limiter.js";
import { CodeRequestManager, MESSAGES } from "./job-manager.js";

const requestBodySchema = z
  .object({
    email: z.string().trim().max(254).email(),
  })
  .strict();

const GENERIC_ERROR = { status: "error", message: MESSAGES.error };
const RATE_LIMIT_ERROR = {
  status: "rate_limited",
  message: "Bạn thao tác quá nhanh. Vui lòng thử lại sau.",
};

export interface CreateAppOptions {
  manager: CodeRequestManager;
  emailLimiter?: EmailAttemptLimiter;
  staticDirectory?: string;
  disableIpRateLimit?: boolean;
}

export function createApp(options: CreateAppOptions): express.Express {
  const app = express();
  const emailLimiter = options.emailLimiter ?? new EmailAttemptLimiter();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "8kb", strict: true }));

  const creationLimiter = options.disableIpRateLimit
    ? (_request: Request, _response: Response, next: NextFunction): void => next()
    : rateLimit({
        windowMs: 10 * 60 * 1_000,
        limit: 30,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        skipFailedRequests: true,
        handler: (_request, response) => {
          response.status(429).json(RATE_LIMIT_ERROR);
        },
      });

  app.use("/api", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.post("/api/code-requests", creationLimiter, (request, response) => {
    const parsed = requestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json(GENERIC_ERROR);
      return;
    }

    const email = normalizeEmail(parsed.data.email);
    if (!emailLimiter.canConsume(email)) {
      response.status(429).json(RATE_LIMIT_ERROR);
      return;
    }

    const result = options.manager.create(email);
    switch (result.status) {
      case "not_found":
        response.status(404).json({
          status: "not_found",
          message: MESSAGES.notFound,
        });
        return;
      case "duplicate":
        response.status(409).json({
          status: "busy",
          message: MESSAGES.busy,
        });
        return;
      case "global_limit":
        response.status(503).json(GENERIC_ERROR);
        return;
      case "queued":
      case "waiting":
        emailLimiter.record(email, result.requestId);
        response.status(202).json({
          status: result.status,
          requestId: result.requestId,
          expiresAt: result.expiresAt.toISOString(),
        });
    }
  });

  app.get("/api/code-requests/:requestId", (request, response) => {
    const job = options.manager.get(request.params.requestId);
    if (!job) {
      response.status(404).json(GENERIC_ERROR);
      return;
    }

    switch (job.status) {
      case "queued":
        response.json({
          status: "queued",
          remainingSeconds: Math.max(
            0,
            Math.ceil((job.expiresAt.getTime() - Date.now()) / 1_000),
          ),
        });
        return;
      case "waiting":
        response.json({
          status: "waiting",
          remainingSeconds: Math.max(
            0,
            Math.ceil((job.expiresAt.getTime() - Date.now()) / 1_000),
          ),
        });
        return;
      case "found":
        response.json({ status: "found", code: job.code });
        return;
      case "timeout":
      case "error":
        response.json({ status: job.status, message: job.message });
    }
  });

  app.delete("/api/code-requests/:requestId", async (request, response) => {
    const job = options.manager.get(request.params.requestId);
    const releasesAttempt = job?.status === "queued" || job?.status === "waiting";
    if (!(await options.manager.cancel(request.params.requestId))) {
      response.status(404).json(GENERIC_ERROR);
      return;
    }
    if (releasesAttempt) {
      emailLimiter.release(request.params.requestId);
    }
    response.status(204).end();
  });

  if (options.staticDirectory) {
    const indexFile = path.join(options.staticDirectory, "index.html");
    const indexTemplate = fs.readFileSync(indexFile, "utf8");
    app.use(express.static(options.staticDirectory, { index: false }));
    app.use((request, response, next) => {
      if (request.method === "GET" && request.accepts("html")) {
        const requestHost = request.get("host") ?? "localhost";
        const safeHost = /^[a-z\d.:[\]-]+$/i.test(requestHost)
          ? requestHost
          : "localhost";
        const imageUrl = `${request.protocol}://${safeHost}/og.png`;
        response
          .type("html")
          .send(indexTemplate.replaceAll("__OG_IMAGE_URL__", imageUrl));
        return;
      }
      next();
    });
  }

  app.use(
    (_error: unknown, _request: Request, response: Response, next: NextFunction) => {
      void next;
      response.setHeader("Cache-Control", "no-store");
      response.status(500).json(GENERIC_ERROR);
    },
  );

  return app;
}
