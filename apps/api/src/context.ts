import type { ServiceEnv } from "@codesentra/config";
import type { Database } from "@codesentra/db";
import type { GithubApp } from "@codesentra/github";
import type { QueueClient, RunEventListener } from "@codesentra/queue";
import type { ObjectStore } from "@codesentra/storage";
import type { AuthService } from "./auth/service.js";
import type { Authz } from "./authz.js";
import type { EmailTransport } from "./email.js";
import type { CookieSettings } from "./session-plugin.js";

export interface AppContext {
  config: ServiceEnv<"api">;
  db: Database;
  auth: AuthService;
  authz: Authz;
  queue: QueueClient;
  events: RunEventListener;
  /** null when the email integration is not configured. */
  email: EmailTransport | null;
  /** null when the s3 integration is not configured. */
  store: ObjectStore | null;
  cookie: CookieSettings;
  /** Injected for GitHub OAuth so tests can point at a local fake. */
  fetch: typeof fetch;
  /** null when the github_app integration is not configured. */
  github?: GithubApp | null;
}
