import { DEFAULTS, listCampaigns, saveCampaign } from "../campaigns";
import { log, type Ctx } from "../context";
import { randomToken, signValue, verifySigned } from "../crypto";
import { explainError } from "../meta/client";
import { checkApp, exchangeCode, findInstagramAccount, graphBase, GraphMetaClient, loginDialogUrl, WEBHOOK_FIELDS } from "../meta/graph";
import { refreshMediaStatsSoon } from "../insights";
import { deleteSettings, saveSettings } from "../settings";
import { listActivity } from "../stats";
import { MINUTE } from "../time";
import { activityTable } from "./dashboard";
import { copyField, fmtTime, html, page, redirect, type Html } from "./html";

export const TEST_KEYWORD = "OWNCHATS";
const TEST_CAMPAIGN = "Setup test";

type StepState = "done" | "todo" | "fail" | "info";

function step(n: number, state: StepState, title: string, body: Html): Html {
  const mark = state === "done" ? "✓" : state === "fail" ? "!" : String(n);
  return html`<section class="card step ${state === "info" ? "" : state}" id="step-${n}"><div class="mark">${mark}</div>
    <div class="body"><h3>${title}</h3>${body}</div></section>`;
}

/** Remembers the deployment's own address, for the values Meta needs and for the Cron. */
export async function rememberBaseUrl(ctx: Ctx, url: URL): Promise<void> {
  const base = url.origin;
  const updates: Record<string, string> = {};
  if (ctx.settings.base_url !== base) updates.base_url = base;
  if (!ctx.settings.verify_token) updates.verify_token = randomToken(18);
  if (Object.keys(updates).length) {
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, updates);
    Object.assign(ctx.settings, updates);
  }
}

export async function setupPage(ctx: Ctx, url: URL, message = ""): Promise<Response> {
  await rememberBaseUrl(ctx, url);
  const s = ctx.settings;
  const base = s.base_url!;
  const appEntered = !!(s.meta_app_id && s.meta_app_secret && s.meta_config_id);
  const connected = !!(s.access_token && s.ig_user_id);
  const verified = !!s.webhook_verified_at;
  const subscribed = (s.subscribed_fields ?? "").split(",").filter(Boolean);
  const allSubscribed = WEBHOOK_FIELDS.every((f) => subscribed.includes(f));
  const published = !!s.published_confirmed_at;
  const [problemAt, problem] = (s.last_webhook_problem ?? "").split("|");
  const webhookProblem = problem && Number(problemAt) > Number(s.last_webhook_at ?? 0) ? problem : "";

  const campaigns = await listCampaigns(ctx.db);
  const test = campaigns.find((c) => c.name === TEST_CAMPAIGN);
  const testRows = test ? await listActivity(ctx, { campaignId: test.id, limit: 20 }) : [];
  const has = (kind: string, outcome: string) => testRows.some((r) => r.kind === kind && r.outcome === outcome);
  const testDone = has("private_reply", "sent") && has("tap", "received") && has("email", "saved") && has("link", "sent");
  const waitingForTest = !!test?.active && !testDone;
  const shortPassword = (ctx.env.ADMIN_PASSWORD ?? "").length < 12;

  const body = html`<h1>Set up OwnChats</h1>
    <p>Work down the list. Each step turns green once OwnChats can see that it works. It takes about an hour, mostly in Meta's dashboard.</p>
    ${message ? html`<div class="card notice">${message}</div>` : ""}
    ${shortPassword ? html`<div class="card notice">Your admin password is shorter than 12 characters. Anyone who guesses it can read your leads. Change <code>ADMIN_PASSWORD</code> in Cloudflare (Workers &amp; Pages, this Worker, Settings, Variables and Secrets). You will then enter the Meta values below again.</div>` : ""}

    ${step(1, "info", "Prepare your Instagram account", html`
      <ul>
        <li>It must be a <b>Creator</b> or <b>Business</b> account, and <b>public</b>. Meta sends no comment notifications for private accounts.</li>
        <li>In the Instagram app: Settings, then <b>Messages and story replies</b>, then <b>Message controls</b> (or <b>Connected tools</b>), and turn on <b>Allow access to messages</b>. Without it every DM fails.</li>
        <li>If ManyChat or another tool answers comments on a Reel, don't arm that Reel here too: a second private reply to the same comment fails. If such a tool was ever connected, open Meta Business Suite, Settings, Advanced (or Integrations), <b>Conversation routing</b>, and make sure it does not take the conversations OwnChats starts.</li>
      </ul>`)}

    ${step(2, "info", "Create a Meta business portfolio", html`
      <p>Meta now asks for one before an Instagram app can be set up. It's free: go to <a href="https://business.facebook.com/" target="_blank" rel="noopener">business.facebook.com</a>, sign in with Facebook, and create a business portfolio with your name. Then add your Instagram account to it: Settings, then Accounts, then Instagram accounts.</p>`)}

    ${step(3, appEntered ? "done" : "todo", "Create your Meta app", html`
      <ol>
        <li>Go to <a href="https://developers.facebook.com/apps/" target="_blank" rel="noopener">developers.facebook.com/apps</a>. If it's your first time, register as a developer (Meta sends codes to your phone and email).</li>
        <li>Click <b>Create app</b>. Name it anything (for example "OwnChats for yourname"). For the use case, choose <b>Manage messaging &amp; content on Instagram</b>, and no other. When asked, pick your business portfolio.</li>
        <li>In the use case, open <b>API setup with Unified login</b>. Create a <b>configuration</b>:
          <ul>
            <li>Token type: <b>System-user access token</b>, expiring <b>Never</b>.</li>
            <li>Tick <b>Instagram Login Compatible</b> if you see it, so you can log in with Instagram.</li>
            <li>Assets: your Instagram account only.</li>
            <li>Permissions: <code>instagram_basic</code>, <code>instagram_manage_comments</code>, <code>instagram_manage_messages</code> and <code>instagram_manage_insights</code>. The last one lets each campaign show its post's views and reach; without it everything else still works.</li>
          </ul>
          Copy its <b>Configuration ID</b>.</li>
        <li>Add <code>business_management</code> to the same configuration. Meta hides it on that page: add the <b>Facebook Login for Business</b> product to the app, open its <b>Configurations</b>, click <b>Edit</b> on your configuration, and tick it there. Without it Meta may connect you but list no Instagram account.</li>
        <li>In <b>Facebook Login for Business</b>, then <b>Settings</b>, paste this into <b>Valid OAuth Redirect URIs</b> and save:</li>
      </ol>
      ${copyField(`${base}/setup/callback`)}
      <ol start="6"><li>In <b>App settings</b>, then <b>Basic</b>, copy the <b>App ID</b> and the <b>App secret</b> (click Show).</li></ol>
      <form method="post" action="/setup/app">
        <label for="app_id">App ID</label><input id="app_id" name="app_id" type="text" inputmode="numeric" value="${s.meta_app_id ?? ""}" required>
        <label for="app_secret">App secret</label><input id="app_secret" name="app_secret" type="password" placeholder="${s.meta_app_secret ? "saved; paste again to replace" : ""}" ${s.meta_app_secret ? "" : "required"}>
        <label for="config_id">Configuration ID</label><input id="config_id" name="config_id" type="text" inputmode="numeric" value="${s.meta_config_id ?? ""}" required>
        <p class="hint">The app secret is stored encrypted. OwnChats checks the ID and secret with Meta when you save.</p>
        <p><button>Save and check</button></p>
      </form>`)}

    ${step(4, connected ? "done" : appEntered ? "todo" : "info", "Connect Instagram", connected
      ? html`<p>Connected to <b>@${s.ig_username}</b>.${s.token_problem ? html` <span class="bad">${s.token_problem}</span>` : ""}</p>
          <p class="row"><a class="button secondary" href="/setup/connect">Reconnect</a></p>`
      : appEntered
        ? html`<p>Meta asks you to log in with Facebook or Instagram and to choose your business portfolio and Instagram account. Allow everything it asks for.</p>
            <p><a class="button" href="/setup/connect">Connect Instagram</a></p>
            <details class="small"><summary>Meta connected you but found no Instagram account?</summary>
              <p>First check <code>business_management</code> (step 3) and that the account is in your business portfolio (step 2). If it still fails, enter your Instagram account's id by hand. Find it in Meta Business Suite: Settings, then Accounts, then Instagram accounts, then your account (the long number). Then connect again.</p>
              <form method="post" action="/setup/account-id"><input name="ig_account_hint" type="text" inputmode="numeric" value="${s.ig_account_hint ?? ""}" placeholder="17841400000000000"><p><button class="secondary">Save the id</button></p></form>
            </details>`
        : html`<p class="muted">Finish step 3 first.</p>`)}

    ${step(5, verified && allSubscribed ? "done" : connected ? "todo" : "info", "Turn on webhooks", html`
      <p>So Meta tells OwnChats about comments, DMs and button taps the moment they happen. In your app's use case, open <b>Configure webhooks</b> (on the Unified login page) and paste:</p>
      <p class="small"><b>Callback URL</b></p>${copyField(`${base}/webhook`)}
      <p class="small"><b>Verify token</b></p>${copyField(s.verify_token ?? "")}
      <p>Click <b>Verify and save</b>, then subscribe to the fields <code>comments</code>, <code>messages</code> and <code>messaging_postbacks</code>.</p>
      <ul class="small">
        <li class="${verified ? "ok" : "warn"}">${verified ? `Meta verified the callback on ${fmtTime(Number(s.webhook_verified_at))}.` : "Waiting for Meta to verify the callback URL."}</li>
        <li class="${allSubscribed ? "ok" : "warn"}">${allSubscribed ? "Your Instagram account is subscribed to the app's webhooks." : connected ? "Your Instagram account is not subscribed yet." : "Connect Instagram first."}</li>
        <li class="${webhookProblem ? "bad" : "muted"}">${webhookProblem ? `Last webhook was refused: ${webhookProblem}. Check the app secret in step 3.` : s.last_webhook_at ? `Last webhook received ${fmtTime(Number(s.last_webhook_at))}.` : "No webhook received yet."}</li>
      </ul>
      ${connected ? html`<form method="post" action="/setup/subscribe"><button class="secondary">Subscribe the account again</button></form>` : ""}`)}

    ${step(6, published ? "done" : "todo", "Publish the app", html`
      <p>In Development mode Meta only delivers events from people with a role on the app, so real commenters would be ignored. In <b>App settings</b>, then <b>Basic</b>, paste these three addresses, pick a category, and save:</p>
      <p class="small"><b>Privacy policy URL</b></p>${copyField(`${base}/privacy`)}
      <p class="small"><b>Terms of service URL</b></p>${copyField(`${base}/terms`)}
      <p class="small"><b>User data deletion</b> (instructions URL)</p>${copyField(`${base}/data-deletion`)}
      <p>Then open <b>Publish</b> (or switch App mode to <b>Live</b>) and publish. Meta's docs say an app that only serves your own account needs no App Review. If Meta asks for Business Verification or App Review before it lets you publish, note what it asked: that is exactly what the first real test needs to find out.</p>
      <details class="small"><summary>Want to test before publishing?</summary>
        <p>In Development mode, comments from an <b>Instagram tester</b> do arrive. In the app, open <b>App roles</b>, then <b>Roles</b>, and add your second account as an Instagram tester. Accept the invite from that account at instagram.com: Settings, then Website permissions, then Apps and websites, then Tester invites. The real proof is still a comment from an account with no role, after publishing.</p>
      </details>
      ${published
        ? html`<p class="ok">You marked the app as published on ${fmtTime(Number(s.published_confirmed_at))}.</p>`
        : html`<form method="post" action="/setup/published"><button class="secondary">I published it</button></form>`}`)}

    ${step(7, testDone ? "done" : connected ? "todo" : "info", "Test with a second account", html`
      <p>Your own comments never trigger anything, so use another Instagram account that has no role on the app (a friend's, or a second account of yours).</p>
      ${!test
        ? html`<form method="post" action="/setup/test"><p>This creates a campaign called "${TEST_CAMPAIGN}" for the keyword <b>${TEST_KEYWORD}</b> on all your posts, with the button and the email question turned on.</p><button ${connected ? "" : "disabled"}>Create the test campaign</button></form>`
        : html`<ol>
            <li>From the second account, comment <b>${TEST_KEYWORD}</b> on any of your posts.</li>
            <li>Within a minute you should see a public reply, and a DM in the second account's <b>message requests</b>. Tap the button.</li>
            <li>Reply to the email question with any email address.</li>
          </ol>
          <ul class="small">
            ${[
              ["Comment received and first DM sent", has("private_reply", "sent")],
              ["Public reply posted", has("public_reply", "sent")],
              ["Button tap received", has("tap", "received")],
              ["Email saved", has("email", "saved")],
              ["Link sent", has("link", "sent")],
            ].map(([label, ok]) => html`<li class="${ok ? "ok" : "muted"}">${ok ? "✓" : "○"} ${label}</li>`)}
          </ul>
          ${testDone ? html`<p class="ok"><b>Everything works.</b> Turn the test campaign off and create your first real one.</p>` : html`<p class="muted small">This page refreshes itself every 10 seconds while it waits.</p>`}
          ${testRows.length ? activityTable(testRows, new Map([[test.id, test.name]])) : ""}
          ${troubleshooting(testRows.length > 0, verified, published)}
          <form method="post" action="/setup/test" class="row"><button class="secondary" name="do" value="${test.active ? "off" : "on"}">${test.active ? "Turn the test campaign off" : "Turn the test campaign on"}</button></form>`}`)}

    ${step(8, campaigns.some((c) => c.name !== TEST_CAMPAIGN) ? "done" : "info", "Create your first campaign", html`
      <p>Choose a keyword, the Reel (or all posts), and the link. <a class="button" href="/dashboard/campaigns/new">New campaign</a></p>`)}
  `;
  return page("Set up OwnChats", body, {
    nav: true,
    head: waitingForTest ? html`<meta http-equiv="refresh" content="10">` : undefined,
  });
}

function troubleshooting(sawSomething: boolean, verified: boolean, published: boolean): Html {
  return html`<details class="small"><summary>Nothing happens?</summary><ul>
    ${!verified ? html`<li>Meta has not verified the webhook yet (step 5).</li>` : ""}
    ${!published ? html`<li>The app is still in Development mode (step 6): Meta ignores people with no role on it.</li>` : ""}
    <li>Comment from an account that is not yours and has no role on the app. Comments from your own account are ignored on purpose.</li>
    <li>OwnChats also checks your posts for comments every minute, so even without webhooks a comment should show up within about two minutes.</li>
    ${sawSomething ? html`<li>If the first DM failed, the reason from Meta is in the table above. "permission missing" usually means "Allow access to messages" is off in Instagram (step 1).</li>` : ""}
    <li>If the DM went out but the button tap never arrives, check that <code>messaging_postbacks</code> is subscribed (step 5) and that no other tool owns your conversations (step 1).</li>
  </ul></details>`;
}

export async function saveAppValues(ctx: Ctx, request: Request, url: URL): Promise<Response> {
  const form = await request.formData();
  const appId = String(form.get("app_id") ?? "").trim();
  const secret = String(form.get("app_secret") ?? "").trim() || ctx.settings.meta_app_secret || "";
  const configId = String(form.get("config_id") ?? "").trim();
  if (!/^\d{5,20}$/.test(appId) || !/^\d{5,20}$/.test(configId) || !secret) {
    return setupPage(ctx, url, "The App ID and Configuration ID are numbers, and the App secret is needed. Copy them again from Meta's dashboard.");
  }
  try {
    await checkApp(graphBase(ctx.env), appId, secret);
  } catch (err) {
    return setupPage(ctx, url, `Meta did not accept that App ID and secret: ${explainError(err).detail}`);
  }
  const changedApp = appId !== ctx.settings.meta_app_id;
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { meta_app_id: appId, meta_app_secret: secret, meta_config_id: configId });
  if (changedApp) await deleteSettings(ctx.db, ["access_token", "ig_user_id", "ig_username", "subscribed_fields", "webhook_verified_at"]);
  return redirect("/setup#step-4");
}

/** Starts Facebook Login for Business. The state is signed and expires in 10 minutes. */
export async function startConnect(ctx: Ctx): Promise<Response> {
  const s = ctx.settings;
  if (!s.meta_app_id || !s.meta_config_id || !s.base_url) return redirect("/setup#step-3");
  const state = await signValue(ctx.env.ADMIN_PASSWORD!, `connect:${ctx.now() + 10 * MINUTE}`);
  return redirect(loginDialogUrl(s.meta_app_id, s.meta_config_id, `${s.base_url}/setup/callback`, state));
}

export async function finishConnect(ctx: Ctx, url: URL): Promise<Response> {
  const s = ctx.settings;
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (error) return setupPage(ctx, url, `Meta stopped the connection: ${error}`);
  const state = await verifySigned(ctx.env.ADMIN_PASSWORD!, url.searchParams.get("state") ?? "");
  if (!state?.startsWith("connect:") || Number(state.slice(8)) < ctx.now()) {
    return setupPage(ctx, url, "That connection link expired. Click Connect Instagram again.");
  }
  const code = url.searchParams.get("code");
  if (!code || !s.meta_app_id || !s.meta_app_secret || !s.base_url) return redirect("/setup#step-3");
  const base = graphBase(ctx.env);
  try {
    const token = await exchangeCode(base, s.meta_app_id, s.meta_app_secret, `${s.base_url}/setup/callback`, code);
    const account = await findInstagramAccount(base, token, s.ig_account_hint || undefined);
    const client = new GraphMetaClient(base, token, account.id, s.meta_app_id, s.meta_app_secret);
    await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, {
      access_token: token,
      ig_user_id: account.id,
      ig_username: account.username,
      token_problem: "",
    });
    Object.assign(ctx.settings, { access_token: token, ig_user_id: account.id, ig_username: account.username });
    ctx.meta = client;
    await refreshMediaStatsSoon(ctx);
    await subscribe(ctx);
    await log(ctx, { kind: "token", outcome: "saved", reason: `connected @${account.username}` });
  } catch (err) {
    return setupPage(ctx, url, `Connecting failed: ${explainError(err).detail}. Check that the configuration has the permissions listed in step 3 and that your Instagram account is in your business portfolio (step 2).`);
  }
  return redirect("/setup#step-5");
}

async function subscribe(ctx: Ctx): Promise<string> {
  if (!ctx.meta) return "Instagram is not connected.";
  try {
    await ctx.meta.subscribeWebhooks(WEBHOOK_FIELDS);
  } catch (err) {
    return `Meta refused the subscription: ${explainError(err).detail}`;
  }
  const fields = await ctx.meta.getSubscribedFields().catch(() => [] as string[]);
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { subscribed_fields: fields.join(",") });
  ctx.settings.subscribed_fields = fields.join(",");
  return "";
}

export async function resubscribe(ctx: Ctx, url: URL): Promise<Response> {
  const problem = await subscribe(ctx);
  return problem ? setupPage(ctx, url, problem) : redirect("/setup#step-5");
}

export async function confirmPublished(ctx: Ctx): Promise<Response> {
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { published_confirmed_at: String(ctx.now()) });
  return redirect("/setup#step-7");
}

export async function testCampaign(ctx: Ctx, request: Request): Promise<Response> {
  const form = await request.formData();
  const action = String(form.get("do") ?? "create");
  const existing = (await listCampaigns(ctx.db)).find((c) => c.name === TEST_CAMPAIGN);
  if (existing) {
    await ctx.db.prepare("UPDATE campaigns SET active = ?, updated_at = ? WHERE id = ?").bind(action === "on" ? 1 : 0, ctx.now(), existing.id).run();
    return redirect("/setup#step-7");
  }
  await saveCampaign(
    ctx.db,
    {
      name: TEST_CAMPAIGN,
      keywords: [TEST_KEYWORD],
      anyComment: false,
      mediaId: null,
      mediaLabel: null,
      nextPostAfter: null,
      publicReplies: DEFAULTS.publicReplies,
      openingText: "This is the OwnChats setup test. Tap the button to continue.",
      openingButton: "Continue",
      emailMode: "first",
      emailPrompt: "Test: reply with any email address. It is saved in your OwnChats leads.",
      emailReask: DEFAULTS.emailReask,
      emailThanks: "Thanks {name}, test complete. Here is the link:",
      optionalPrompt: DEFAULTS.optionalPrompt,
      optionalThanks: DEFAULTS.optionalThanks,
      consentText: "OwnChats setup test",
      linkText: "Test complete. Here is the link:",
      links: [{ label: DEFAULTS.linkLabel, url: "https://github.com/psabbagh/ownchats" }],
      dmKeyword: false,
      active: true,
    },
    null,
    ctx.now(),
  );
  return redirect("/setup#step-7");
}


export async function saveAccountHint(ctx: Ctx, request: Request, url: URL): Promise<Response> {
  const hint = String((await request.formData()).get("ig_account_hint") ?? "").trim();
  if (hint && !/^\d{5,25}$/.test(hint)) return setupPage(ctx, url, "The Instagram account id is a long number.");
  await saveSettings(ctx.db, ctx.env.ADMIN_PASSWORD, { ig_account_hint: hint });
  return redirect("/setup#step-4");
}
