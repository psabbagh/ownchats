import type { Ctx } from "../context";
import { html, page } from "./html";

/**
 * The pages Meta requires before an app can be published, served by OwnChats
 * itself so nobody needs a website. They describe what this deployment does.
 */
function owner(ctx: Ctx) {
  const handle = ctx.settings.ig_username ? `@${ctx.settings.ig_username}` : "the Instagram account that runs this service";
  const contact = ctx.settings.contact || (ctx.settings.ig_username ? `a DM to @${ctx.settings.ig_username} on Instagram` : "a DM to the account on Instagram");
  return { handle, contact };
}

export function privacyPage(ctx: Ctx): Response {
  const { handle, contact } = owner(ctx);
  return page(
    "Privacy policy",
    html`<h1>Privacy policy</h1>
      <p>This service sends automatic Instagram replies and messages for ${handle}. It runs on ${handle}'s own Cloudflare account using OwnChats, open-source software. This page explains what it stores.</p>
      <h2>What is collected</h2>
      <ul>
        <li>When you comment on a post that has an active campaign: your Instagram username, the Instagram-scoped id Meta gives this service, the comment text and its time.</li>
        <li>When you message the account or tap a button in its messages: the same id and what you sent, used only to answer you.</li>
        <li>If you choose to give your email address in a message: the address, the wording of the question you answered, and the time.</li>
      </ul>
      <h2>How it is used</h2>
      <p>To reply to your comment, send you what you asked for, and, if you gave your email, to send you what the question said you would receive. Nothing is sold or shared with anyone else. Data is processed by Meta (Instagram) and stored by Cloudflare, which hosts the service.</p>
      <h2>How long it is kept</h2>
      <p>Comment and message records are deleted after 90 days. Email addresses are kept until you ask for them to be deleted or ${handle} deletes them.</p>
      <h2>Your rights</h2>
      <p>You can ask to see or delete your data at any time. See <a href="/data-deletion">how to delete your data</a>, or contact ${contact}.</p>`,
  );
}

export function dataDeletionPage(ctx: Ctx): Response {
  const { handle, contact } = owner(ctx);
  return page(
    "Delete your data",
    html`<h1>How to delete your data</h1>
      <p>This service, run by ${handle}, stores your Instagram username and id, your comments and messages to the account, and your email address if you gave it.</p>
      <p>To have all of it deleted, send ${contact} asking for your data to be deleted. Include your Instagram username. Everything stored about you is deleted, usually within a few days, and you get a reply when it is done. Only the id of each of your comments is kept, with nothing else, for up to 30 days, so they are never answered or stored again.</p>
      <p>You can also remove this service's access through Instagram: Settings, then Apps and websites.</p>`,
  );
}

export function termsPage(ctx: Ctx): Response {
  const { handle } = owner(ctx);
  return page(
    "Terms",
    html`<h1>Terms</h1>
      <p>This service sends automatic replies and messages for ${handle} when you comment a keyword or message the account. It is provided as-is, without any guarantee that a message will be delivered.</p>
      <p>Using it means agreeing that your comment and messages are processed as described in the <a href="/privacy">privacy policy</a>.</p>`,
  );
}
