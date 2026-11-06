# OwnChats

Your own Instagram comment-to-DM bot. Someone comments a keyword on your Reel, and OwnChats replies under the comment and sends them a DM with your link. It can ask for their email first. It runs free on your own Cloudflare account, so there is no per-contact pricing and the leads are yours.

I built this for my own Instagram account and I'm sharing it as-is. Take it, change it, run it. I don't promise support.

**Status: v0, built in public.** It has answered real comments and DMs on my Instagram account since 2026-11-04. It has only run on one account so far, and one part is still unproven (see [What's proven so far](#whats-proven-so-far)), so treat it as an early version.

## What it does

- **Keyword, then link.** Someone comments AGENTS on your Reel. OwnChats replies under the comment ("Sent! Check your DMs") and sends a DM with a "Send me the link" button. The tap sends the link.
- **Email, three ways, per campaign:**
  - **Link only.**
  - **Link plus optional email:** the link comes right away with "Reply with your email if you want more". An email reply is saved; anything else is left alone.
  - **Email first:** it asks for their email and says what they'll get. A valid email is saved and the link goes out. Anything else gets one re-ask, then the link goes out anyway, so nobody leaves empty-handed.
- **Every word is yours.** Each campaign's public replies, DMs, button labels, links (up to three) and consent wording are editable, with defaults that work as they are. Write `{name}` to greet people by name.
- **DM keyword.** Someone sends AGENTS by DM (for example, their comment is older than a week) and gets the same flow. Off by default; switch it on per campaign.
- **One post or all posts.** Arm a campaign on one Reel, or on all your posts so it's live before the Reel goes up. A campaign on one post can also answer every comment, keyword or not.
- **Varied public replies**, picked at random and never the same twice in a row, so identical replies on a busy post don't get your comments limited.
- **A dashboard** with your campaigns, your leads and an activity log. Each campaign shows every comment on its post and why it did or didn't get a DM, and how many people tapped, gave their email and got the link. It also shows the post's views, reach, likes, shares and saves from Instagram, and what share of the views led to a DM.
- **Your leads where you work:** CSV download, a live Google Sheet with one formula, and a read-only JSON API for your own tools.

## What you need

- An Instagram **Creator** or **Business** account, set to public
- A Facebook account, to create a free Meta developer account and a free Meta business portfolio of your own (not your employer's)
- A free **GitHub** account and a free **Cloudflare** account
- A second Instagram account to test with (a friend's works)
- About an hour, most of it in Meta's dashboard

You don't need a domain, a server, or to write any code.

## Set it up

### 1. Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/psabbagh/ownchats)

Click the button and sign in to GitHub and Cloudflare (create the accounts if you need to). Cloudflare copies OwnChats into your GitHub, creates its database, and deploys it.

It asks for one thing, **ADMIN_PASSWORD**: choose a long password and save it in your password manager. It protects your dashboard and your leads.

When it's done, Cloudflare shows your OwnChats address, something like `https://ownchats.yourname.workers.dev`.

### 2. Follow the checklist

Open your OwnChats address and sign in with your password. You land on **/setup**, a checklist that checks itself. For each step it shows the exact value to paste into Meta's dashboard, with a copy button, and turns green once the step really works:

1. Prepare your Instagram account (Creator or Business, public, "Allow access to messages" on)
2. Create a Meta business portfolio
3. Create your Meta app ("Manage messaging & content on Instagram") and paste its App ID, App secret and Configuration ID
4. Connect Instagram
5. Turn on webhooks
6. Publish the app (OwnChats serves the privacy, terms and data-deletion pages Meta asks for)
7. Test with a second account: comment OWNCHATS on any post and watch the reply, the DM, the tap, the email and the link arrive
8. Create your first campaign

### Or: set it up with an AI agent

[docs/guide-for-ai-agents.md](docs/guide-for-ai-agents.md) is written for an AI agent to follow: what Meta's screens actually showed during the first real setup, the problems we hit and how we fixed them, how to diagnose a missed comment, and how to update your copy. If you use Claude Code, Codex or another agent that can use a browser, paste this:

```text
I want to set up OwnChats, an Instagram comment-to-DM bot, from
https://github.com/psabbagh/ownchats. First read docs/guide-for-ai-agents.md,
then the README and docs/design.md, and follow the guide's ground rules.
Walk me through it one step at a time: the Deploy to Cloudflare button, then
every step of the /setup checklist on my OwnChats address, including Meta's
developer dashboard. Tell me exactly where to click and what to paste. I type
every password, app secret and token myself. If a screen doesn't match what
the guide or the checklist says, tell me what you see and we'll work it out.
At the end, help me run the test with my second account.
```

## Using it

- **Campaigns:** in the dashboard, New campaign. Pick the keyword (add extra spellings with commas), the post or all posts, and the link. Then adjust any of the wording if you like: the public replies, the first DM and its button, the email mode and its messages.
- **Only one tool per Reel.** Instagram allows one private reply per comment. If ManyChat or another tool also answers a Reel, the second one fails. Move a Reel to OwnChats by turning it off in the other tool first. While the other tool's Instagram channel stays connected, it can keep the DM threads to itself, so button taps and DMs may not reach OwnChats; the [guide](docs/guide-for-ai-agents.md#moving-from-manychat-or-another-tool) explains how to switch it off.
- **Leads:** the Leads page lists every email with the wording the person agreed to and when. Download a CSV there.
- **Google Sheets:** Settings, Create link, then paste the `=IMPORTDATA("...")` formula it shows into cell A1 of a sheet. It refreshes about once an hour. Anyone with the link can read your leads, so you can regenerate or turn it off at any time.
- **API:** Settings, Create token. Then `GET /api/campaigns`, `/api/leads`, `/api/activity`, `/api/posts` (your posts from the last 90 days with Instagram's numbers), `/api/account` (your follower count) and `/api/stats` with `Authorization: Bearer <token>`. `GET /api` lists them. It's read-only.
- **Someone asks for their data to be deleted:** Leads, "Delete someone's data", enter their username, then Find their data. It shows what OwnChats stores about them; Delete their data removes it.

## Instagram's rules, which OwnChats follows

- One private reply per comment, within 7 days of the comment.
- After that, more messages only once the person answers (the button tap counts), and only within 24 hours of their answer. OwnChats only ever replies to something the person just did.
- At most 750 private replies an hour per account. OwnChats stays under 700 and queues the rest.
- People who don't follow you get the DM in their message requests, so the default public replies say so.
- Your own comments never trigger anything. Test from a second account.
- There's no way to DM someone when they follow you: Meta has no such event for apps like this.

## What's proven so far

The first real run, on my account on 2026-11-04, settled the question Meta's docs contradict themselves on. With the app published, on Standard Access, and without App Review or Business Verification:

- Comments from strangers arrive within about a second, and they get the DM and the public reply.
- The button in the first DM works.
- Typed DMs arrive, so DM keywords and the email question work.
- The email chain works end to end, through to the Leads page and Google Sheets.

Still unproven: whether a tap on the "Send me the link" button reaches OwnChats from a stranger. The only test ran while ManyChat still held that DM thread. A campaign without the button sends the link in the first DM and doesn't depend on it. The [guide](docs/guide-for-ai-agents.md#whats-proven-so-far) has the details.

Meta changed how new apps connect in October 2026 ("Unified Login", which needs a business portfolio). OwnChats is built for that path; older guides for other tools are not.

## Updating your copy

Your copy on GitHub is yours, and Cloudflare redeploys it each time it changes. The Deploy button makes it as a fresh copy with no shared history with this repository, so a plain `git pull` from here refuses to merge. To pull in fixes, you apply what changed here since your copy was made. The [guide](docs/guide-for-ai-agents.md#updating-a-copy) has the exact commands, tested on a real copy; you can also ask your AI agent to follow them.

Database changes apply themselves on the next deploy.

Set up before 2026-11-06? To see views on each campaign, add `instagram_manage_insights` to your Meta login configuration, then click Reconnect on `/setup`. The [guide](docs/guide-for-ai-agents.md#views-on-each-campaign) says where.

## Costs and privacy

OwnChats fits Cloudflare's free plan: one small Worker, one database, a check every minute. Your leads, comments and messages stay in your own Cloudflare database. Nothing is sent anywhere except to Meta, to reply and send DMs. The activity log keeps 90 days; leads stay until you delete them.

## For developers

TypeScript on Cloudflare Workers with D1, no framework. `npm install`, then `npm run check` (types) and `npm test` (Vitest inside the Workers runtime, with a fake Meta client that enforces Meta's limits). `npm run dev` runs it locally with a `.dev.vars` file holding `ADMIN_PASSWORD`. The design and its reasons are in [docs/design.md](docs/design.md).

## License

[MIT](LICENSE)
