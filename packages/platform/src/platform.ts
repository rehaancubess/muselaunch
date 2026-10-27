import { hostname } from "node:os";
import { createDb, type Db } from "@muselaunch/db";
import { loadConfig, type Config } from "./config";
import { CreditService } from "./credits";
import { CloudTasksDispatcher, HttpDispatcher, InlineDispatcher, JobRunner, JobService, type HandlerRegistry } from "./jobs";
import { createLogger, type Logger } from "./logger";
import { SecretStore } from "./secrets";
import { createStorage, type ObjectStorage } from "./storage";
import { UsageMeter } from "./usage";

/** Shared service container used by the API, workers and tests. */
export interface Platform {
  cfg: Config;
  log: Logger;
  db: Db;
  storage: ObjectStorage;
  jobs: JobService;
  credits: CreditService;
  usage: UsageMeter;
  secrets: SecretStore;
  /** Present only with JOB_DISPATCH=inline. */
  inline?: InlineDispatcher;
}

export interface CreatePlatformOptions {
  cfg?: Config;
  db?: Db;
  storage?: ObjectStorage;
  log?: Logger;
}

export function createPlatform(opts: CreatePlatformOptions = {}): Platform {
  const cfg = opts.cfg ?? loadConfig();
  const log = opts.log ?? createLogger({ level: cfg.LOG_LEVEL });
  const db = opts.db ?? createDb({ driver: cfg.DB_DRIVER, projectId: cfg.FIREBASE_PROJECT_ID, databaseId: cfg.FIRESTORE_DATABASE_ID });
  const storage = opts.storage ?? createStorage(cfg);
  const credits = new CreditService(db, cfg);
  const jobs = new JobService(db, credits, log);
  const usage = new UsageMeter(db, storage, cfg, log);
  const secrets = new SecretStore(db, cfg);
  let inline: InlineDispatcher | undefined;
  if (cfg.JOB_DISPATCH === "inline") {
    inline = new InlineDispatcher();
    jobs.setDispatcher(inline);
  } else if (cfg.JOB_DISPATCH === "http") {
    jobs.setDispatcher(new HttpDispatcher(cfg, log));
  } else {
    jobs.setDispatcher(new CloudTasksDispatcher(cfg, log));
  }
  return { cfg, log, db, storage, jobs, credits, usage, secrets, inline };
}

/** Build a runner for this process and (inline mode) attach it to the dispatcher. */
export function createRunner(p: Platform, handlers: HandlerRegistry, workerId = `${hostname()}:${process.pid}`): JobRunner {
  const runner = new JobRunner({ db: p.db, jobs: p.jobs, log: p.log }, handlers, workerId);
  p.inline?.setRunner(runner);
  return runner;
}
