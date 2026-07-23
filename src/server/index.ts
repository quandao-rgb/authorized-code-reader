import path from "node:path";
import "dotenv/config";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { CodeRequestManager } from "./job-manager.js";
import { safeLogger } from "./logger.js";
import { MailWatcher } from "./mail-watcher.js";

async function start(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch {
    safeLogger.error("Configuration is invalid. The server was not started.");
    process.exitCode = 1;
    return;
  }

  const watcher = new MailWatcher();
  const manager = new CodeRequestManager(config, watcher);
  const staticDirectory = path.resolve(process.cwd(), "dist/client");
  const app = createApp({ manager, staticDirectory });
  const server = app.listen(config.port, () => {
    safeLogger.info(`Authorized code reader is listening on port ${config.port}.`);
  });

  let closing = false;
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    manager.shutdown();
    server.close(() => {
      process.exitCode = 0;
    });
    setTimeout(() => {
      process.exitCode = 1;
      server.closeAllConnections();
    }, 10_000).unref();
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void start();
