import { buildCtx, type AppOptions } from "./context";
import { runCron } from "./cron";
import type { Env } from "./env";
import { graphClientFromSettings } from "./meta/graph";
import { receiveWebhook, verifyWebhook } from "./webhook";

export function createApp(options: AppOptions): ExportedHandler<Env> {
  return {
    async fetch(request, env, execution) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const ctx = await buildCtx(env, options);

      if (path === "/webhook") {
        if (request.method === "GET") return verifyWebhook(ctx, url);
        if (request.method === "POST") {
          const { response, work } = await receiveWebhook(ctx, request);
          if (work) execution.waitUntil(work.catch((e) => console.error("webhook processing failed", e)));
          return response;
        }
        return new Response("Method not allowed", { status: 405 });
      }
      if (path === "/health") return new Response("ok");
      return new Response("Not found", { status: 404 });
    },

    async scheduled(_controller, env, execution) {
      const ctx = await buildCtx(env, options);
      execution.waitUntil(runCron(ctx).catch((e) => console.error("cron failed", e)));
    },
  };
}

export default createApp({ meta: graphClientFromSettings });
