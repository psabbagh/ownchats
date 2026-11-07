import { handleApi } from "./api";
import { handleLogin, handleLogout, isAdmin, loginPage, noPasswordPage, sameOrigin } from "./auth";
import { buildCtx, type AppOptions, type Ctx } from "./context";
import { runCron } from "./cron";
import type { Env } from "./env";
import { exportLeads } from "./export";
import { graphClientFromSettings } from "./meta/graph";
import {
  activityPage,
  dashboardHome,
  deleteCampaign,
  deletePersonForm,
  editCampaignPage,
  leadsCsvDownload,
  leadsPage,
  newCampaignPage,
  saveCampaignForm,
  settingsAction,
  settingsPage,
} from "./pages/dashboard";
import { redirect } from "./pages/html";
import { answerMissedForm, campaignResultsPage } from "./pages/results";
import { dataDeletionPage, privacyPage, termsPage } from "./pages/legal";
import { confirmPublished, finishConnect, rememberBaseUrl, resubscribe, saveAccountHint, saveAppValues, setupPage, startConnect, testCampaign } from "./pages/setup";
import { receiveWebhook, verifyWebhook } from "./webhook";

/** Pages that need the admin session. */
async function adminRoutes(ctx: Ctx, request: Request, url: URL): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const post = request.method === "POST";
  if (post && !sameOrigin(request)) return new Response("Cross-site request refused", { status: 403 });
  // The Sheets link, the API docs and the Cron all need this deployment's own address.
  await rememberBaseUrl(ctx, url);

  if (path === "/setup") return setupPage(ctx, url);
  if (path === "/setup/app" && post) return saveAppValues(ctx, request, url);
  if (path === "/setup/account-id" && post) return saveAccountHint(ctx, request, url);
  if (path === "/setup/connect") return startConnect(ctx);
  if (path === "/setup/callback") return finishConnect(ctx, url);
  if (path === "/setup/subscribe" && post) return resubscribe(ctx, url);
  if (path === "/setup/published" && post) return confirmPublished(ctx);
  if (path === "/setup/test" && post) return testCampaign(ctx, request);

  if (path === "/dashboard") return dashboardHome(ctx);
  if (path === "/dashboard/campaigns/new") return post ? saveCampaignForm(ctx, request, null) : newCampaignPage(ctx);
  const campaign = path.match(/^\/dashboard\/campaigns\/(\d+)(\/delete|\/edit|\/answer)?$/);
  if (campaign) {
    const id = Number(campaign[1]);
    if (campaign[2] === "/delete") return post ? deleteCampaign(ctx, id) : null;
    if (campaign[2] === "/answer") return post ? answerMissedForm(ctx, request, id) : null;
    if (campaign[2] === "/edit") return post ? saveCampaignForm(ctx, request, id) : editCampaignPage(ctx, id);
    return post ? saveCampaignForm(ctx, request, id) : campaignResultsPage(ctx, id, url);
  }
  if (path === "/dashboard/leads") return leadsPage(ctx);
  if (path === "/dashboard/leads.csv") return leadsCsvDownload(ctx);
  if (path === "/dashboard/people/delete" && post) return deletePersonForm(ctx, request);
  if (path === "/dashboard/activity") return activityPage(ctx, url);
  if (path === "/dashboard/settings") return settingsPage(ctx);
  const setting = path.match(/^\/dashboard\/settings\/(export|api-token|contact|time-zone)$/);
  if (setting && post) return settingsAction(ctx, request, setting[1]!);
  return null;
}

export function createApp(options: AppOptions): ExportedHandler<Env> {
  return {
    async fetch(request, env, execution) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const ctx = await buildCtx(env, options);

      // Public: Meta, Google Sheets, integrations, and the pages Meta requires.
      if (path === "/webhook") {
        if (request.method === "GET") return verifyWebhook(ctx, url);
        if (request.method === "POST") {
          const { response, work } = await receiveWebhook(ctx, request);
          if (work) execution.waitUntil(work.catch((e) => console.error("webhook processing failed", e)));
          return response;
        }
        return new Response("Method not allowed", { status: 405 });
      }
      if (path === "/privacy") return privacyPage(ctx);
      if (path === "/terms") return termsPage(ctx);
      if (path === "/data-deletion") return dataDeletionPage(ctx);
      if (path === "/export/leads.csv") return exportLeads(ctx, url);
      if (path === "/api" || path.startsWith("/api/")) return handleApi(ctx, request, url);
      if (path === "/health") return new Response("ok");

      // Admin.
      if (!env.ADMIN_PASSWORD) return noPasswordPage();
      if (path === "/login") return request.method === "POST" ? handleLogin(ctx, request) : loginPage("", url.searchParams.get("next") ?? "/dashboard");
      if (path === "/logout" && request.method === "POST") return handleLogout();
      if (path === "/") return redirect(ctx.settings.ig_user_id ? "/dashboard" : "/setup");
      if (!(await isAdmin(ctx, request))) {
        if (path.startsWith("/setup") || path.startsWith("/dashboard")) return redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`);
        return new Response("Not found", { status: 404 });
      }
      return (await adminRoutes(ctx, request, url)) ?? new Response("Not found", { status: 404 });
    },

    async scheduled(_controller, env, execution) {
      const ctx = await buildCtx(env, options);
      execution.waitUntil(runCron(ctx).catch((e) => console.error("cron failed", e)));
    },
  };
}

export default createApp({ meta: graphClientFromSettings });
