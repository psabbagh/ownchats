# OwnChats

Your own Instagram comment-to-DM bot. Someone comments a keyword on your Reel, and OwnChats replies under the comment and sends them a DM with your link. It can ask for their email first. It runs free on your own Cloudflare account, so there is no per-contact pricing and the leads are yours.

I built this for my own Instagram account and I'm sharing it as-is. Take it, change it, run it. I don't promise support.

**Status: v0, being built in public. The code is done and tested against a stand-in for Meta. The first real run on a live Instagram account hasn't happened yet**, and it has to answer one question Meta's docs contradict themselves on (see [What isn't proven yet](#what-isnt-proven-yet)). Until then, treat this as an experiment.

## What it does

- **Keyword, then link.** Someone comments AGENTS on your Reel. OwnChats replies under the comment ("Sent! Check your DMs") and sends a DM with a "Send me the link" button. The tap sends the link.
- **Email, three ways, per campaign:**
  - **Link only.**
  - **Link plus optional email:** the link comes right away with "Reply with your email if you want more". An email reply is saved; anything else is left alone.
  - **Email first:** it asks for their email and says what they'll get. A valid email is saved and the link goes out. Anything else gets one re-ask, then the link goes out anyway, so nobody leaves empty-handed.
- **Every word is yours.** Each campaign's public replies, DMs, button labels, links (up to three) and consent wording are editable, with defaults that work as they are. Write `{name}` to greet people by name.
- **DM keyword.** Someone sends AGENTS by DM (for example, their comment is older than a week) and gets the same flow.
- **One post or all posts.** Arm a campaign on one Reel, or on all your posts so it's live before the Reel goes up. A campaign on one post can also answer every comment, keyword or not.
- **Varied public replies**, picked at random and never the same twice in a row, so identical replies on a busy post don't get your comments limited.
- **A dashboard** with your campaigns, their numbers (people, DMs, taps, emails, links), your leads, and an activity log that says why each comment did or didn't get a DM.
- **Your leads where you work:** CSV download, a live Google Sheet with one formula, and a read-only JSON API for your own tools.

## What you need

- An Instagram **Creator** or **Business** account, set to public
- A Facebook account, to create a free Meta developer account and a free Meta business portfolio
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

### Or: set it up with Claude

If you use Claude (Claude Code, or Claude with browser access), paste this and it will walk you through:

```text
I want to set up OwnChats, an Instagram comment-to-DM bot, from
https://github.com/psabbagh/ownchats. Read its README and docs/design.md first.
Walk me through it one step at a time: the Deploy to Cloudflare button, then
every step of the /setup checklist on my OwnChats address, including the Meta
developer dashboard. Tell me exactly where to click and what to paste.
Rules: never ask me for a password, app secret or token, and never type one
yourself. I type those myself. Don't create accounts for me. If a screen in
Meta's dashboard doesn't match the checklist, tell me what you see and we'll
work it out together. At the end, help me run the test in step 7 with my
second account.
```

## Using it

- **Campaigns:** in the dashboard, New campaign. Pick the keyword (add extra spellings with commas), the post or all posts, and the link. Then adjust any of the wording if you like: the public replies, the first DM and its button, the email mode and its messages.
- **Only one tool per Reel.** Instagram allows one private reply per comment. If ManyChat or another tool also answers a Reel, the second one fails. Move a Reel to OwnChats by turning it off in the other tool first.
- **Leads:** the Leads page lists every email with the wording the person agreed to and when. Download a CSV there.
- **Google Sheets:** Settings, Create link, then paste the `=IMPORTDATA("...")` formula it shows into cell A1 of a sheet. It refreshes about once an hour. Anyone with the link can read your leads, so you can regenerate or turn it off at any time.
- **API:** Settings, Create token. Then `GET /api/campaigns`, `/api/leads`, `/api/activity` and `/api/stats` with `Authorization: Bearer <token>`. `GET /api` lists them. It's read-only.
- **Someone asks for their data to be deleted:** Leads, "Delete someone's data", enter their username.

## Instagram's rules, which OwnChats follows

- One private reply per comment, within 7 days of the comment.
- After that, more messages only once the person answers (the button tap counts), and only within 24 hours of their answer. OwnChats only ever replies to something the person just did.
- At most 750 private replies an hour per account. OwnChats stays under 700 and queues the rest.
- People who don't follow you get the DM in their message requests, so the default public replies say so.
- Your own comments never trigger anything. Test from a second account.
- There's no way to DM someone when they follow you: Meta has no such event for apps like this.

## What isn't proven yet

- **Whether Meta delivers strangers' comments to your own app without App Review.** Meta's docs say an app that only serves your own account needs no review, and also that comment notifications need "Advanced Access". OwnChats also checks your watched posts for new comments every minute, so it doesn't depend on the notifications for comments. But button taps and typed emails only arrive as notifications. The first real run will settle it, and this README will say plainly if App Review turns out to be part of setup.
- **Whether the "Send me the link" button works in a private reply** on new Meta apps. Meta documents only text there. If Meta refuses the button, OwnChats sends the next step as plain text instead and notes it in the activity log.
- **Meta changed how new apps connect in October 2026** ("Unified Login", which needs a business portfolio). OwnChats is built for that path; older guides for other tools are not.

## Updating your copy

Your copy on GitHub is yours, and Cloudflare redeploys it each time it changes. To pull in fixes from this repository, run this once in a copy of your repository on your computer, or ask Claude to do it for you:

```bash
git remote add upstream https://github.com/psabbagh/ownchats.git
```

Then, each time you want the latest version:

```bash
git pull upstream main && git push
```

Database changes apply themselves on the next deploy.

## Costs and privacy

OwnChats fits Cloudflare's free plan: one small Worker, one database, a check every minute. Your leads, comments and messages stay in your own Cloudflare database. Nothing is sent anywhere except to Meta, to reply and send DMs. The activity log keeps 90 days; leads stay until you delete them.

## For developers

TypeScript on Cloudflare Workers with D1, no framework. `npm install`, then `npm run check` (types) and `npm test` (Vitest inside the Workers runtime, with a fake Meta client that enforces Meta's limits). `npm run dev` runs it locally with a `.dev.vars` file holding `ADMIN_PASSWORD`. The design and its reasons are in [docs/design.md](docs/design.md).

## License

[MIT](LICENSE)
