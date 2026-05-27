import { buildDebugSnapshot } from "./debug.js";
import { cookieForm, newYorkHour } from "./formatters.js";
import { logRuntimeEvent, readLogs } from "./logging.js";
import { recordBrowserbaseRefreshFailure } from "./recovery.js";
import {
  appendDailyGuardSkip,
  runCookieFormSave,
  runCookieVerification,
  runDailyDigest,
  runDeltaCheck
} from "./runs.js";
import { handleTelegram } from "./telegram.js";
import type { Env, TelegramUpdate } from "./types.js";
import { html, isAuthorized, json } from "./utils.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    logRuntimeEvent("info", "worker-request-received", {
      method: request.method,
      path: url.pathname
    });

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        logRuntimeEvent("info", "worker-request-completed", {
          method: request.method,
          path: url.pathname,
          status: 200
        });
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/logs") {
        if (!isAuthorized(url, env.COOKIE_FORM_TOKEN)) {
          return unauthorized(request, url);
        }
        return json(await readLogs(env));
      }

      if (request.method === "GET" && url.pathname === "/debug") {
        if (!isAuthorized(url, env.COOKIE_FORM_TOKEN)) {
          return unauthorized(request, url);
        }
        return json(await buildDebugSnapshot(env));
      }

      if (request.method === "GET" && url.pathname === "/verify-cookie") {
        if (!isAuthorized(url, env.COOKIE_FORM_TOKEN)) {
          return unauthorized(request, url);
        }
        const readOnly = url.searchParams.get("persist") === "false";
        return json(await runCookieVerification(
          env,
          readOnly ? "smoke-read-only" : "manual-http",
          readOnly ? { persist: false } : {}
        ));
      }

      if (request.method === "GET" && url.pathname === "/run-delta") {
        if (!isAuthorized(url, env.COOKIE_FORM_TOKEN)) {
          return unauthorized(request, url);
        }
        return json(await runDeltaCheck(env, "manual-http"));
      }

      if (request.method === "GET" && url.pathname === "/run-daily") {
        if (!isAuthorized(url, env.COOKIE_FORM_TOKEN)) {
          return unauthorized(request, url);
        }
        return json(await runDailyDigest(env, "manual-http"));
      }

      if (request.method === "POST" && url.pathname === "/refresh-failed") {
        if (!isAuthorized(url, env.COOKIE_FORM_TOKEN)) {
          return unauthorized(request, url);
        }
        return json(await recordBrowserbaseRefreshFailure(request, env));
      }

      if (request.method === "GET" && url.pathname === "/cookie") {
        if (!isAuthorized(url, env.COOKIE_FORM_TOKEN)) {
          return unauthorized(request, url);
        }
        return html(cookieForm(""));
      }

      if (request.method === "POST" && url.pathname === "/cookie") {
        if (!isAuthorized(url, env.COOKIE_FORM_TOKEN)) {
          return unauthorized(request, url);
        }
        const result = await runCookieFormSave(env, await request.formData());
        return html(cookieForm(result.message), result.status);
      }

      if (request.method === "POST" && url.pathname === "/telegram") {
        const update: TelegramUpdate = await request.json();
        ctx.waitUntil(handleTelegram(update, env, request.url));
        return json({ ok: true });
      }

      logRuntimeEvent("warn", "worker-request-not-found", {
        method: request.method,
        path: url.pathname
      });
      return new Response("Not found", { status: 404 });
    } catch (error) {
      logRuntimeEvent("error", "worker-request-failed", {
        method: request.method,
        path: url.pathname,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    logRuntimeEvent("info", "worker-cron-received", { cron: controller.cron });
    try {
      if (controller.cron === "0 13 * * *" || controller.cron === "0 14 * * *") {
        if (newYorkHour() === "09") {
          await runDailyDigest(env, `cron:${controller.cron}`);
        } else {
          await appendDailyGuardSkip(env, `cron:${controller.cron}`);
        }
        logRuntimeEvent("info", "worker-cron-completed", { cron: controller.cron });
        return;
      }

      await runDeltaCheck(env, `cron:${controller.cron}`);
      logRuntimeEvent("info", "worker-cron-completed", { cron: controller.cron });
    } catch (error) {
      logRuntimeEvent("error", "worker-cron-failed", {
        cron: controller.cron,
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
};

function unauthorized(request: Request, url: URL): Response {
  logRuntimeEvent("warn", "worker-request-unauthorized", {
    method: request.method,
    path: url.pathname
  });
  return new Response("Not found", { status: 404 });
}
