# OwnChats design, v0

Written 2026-11-04, before any code. Update it as decisions change.

## What it is

Your own Instagram comment-to-DM bot. Someone comments a keyword on one of your Reels. OwnChats replies under the comment and sends them a DM with your link, and can ask for their email first. It runs on your own Cloudflare account (free tier) with your own Meta app, so there is no per-contact pricing and the leads are yours.

It was built for the author's own account and is shared as-is. Take it, change it, run it. No support is promised.

## Who it is for

- Creators who will follow a guided setup of about an hour to stop paying per contact.
- Not for people who want a one-click "Connect Instagram" with no setup. A hosted tool is the right choice for them. A hosted OwnChats would mean one Meta app through App Review for everyone, billing and support, and is out of scope.

## Scenarios in v0

1. **Keyword, then link.** A comment containing the keyword on a chosen Reel gets a public reply ("Sent! Check your DMs, it may be under message requests.") and a private reply DM with the link.
2. **Email capture.** The DM asks for an email. A valid email is saved and the link is sent. Anything else gets one re-ask; after a second miss the link is sent anyway, so nobody who commented leaves empty-handed.
3. **Both.** Scenario 1's trigger with scenario 2's DM.
4. **DM keyword.** Someone sends the keyword by DM (for example, their comment is older than 7 days) and gets the same flow.

Matching rules: case-insensitive, whole word, optional extra spellings per campaign (for example AGENTS and AGENT). Comments by the account owner are ignored. One DM per person per campaign, however many times they comment.

## Meta constraints, checked 2026-11-04

- A private reply sends **one** message per comment, within **7 days** of the comment. More messages are allowed only after the person replies, and only within **24 hours** of their reply.
- Private replies are limited to 750 per hour per account.
- People who don't follow the account get the DM in their message requests, so the public reply says so.
- The account owner's own comments never trigger anything, so testing needs a second account.
- Connection: Instagram API with Instagram Login (no Facebook Page needed). The account must be a Creator or Business account.
- Access level is not settled. Meta's platform overview says an app that serves only your own account needs Standard Access and no App Review. Meta's webhook docs say `comments` webhooks need Advanced Access. So OwnChats **polls** the comments of armed Reels every minute and also accepts webhooks when they arrive. The first real run must confirm that private replies reach commenters who have no role on the app.
- Long-lived Instagram tokens last about 60 days. OwnChats refreshes them on a schedule and warns before expiry.

## Architecture

- One Cloudflare Worker in TypeScript, a D1 database, and a Cron trigger every minute.
- Routes:
  - `/webhook`: Meta's verification handshake and incoming events.
  - `/setup`: the setup checklist (below).
  - `/dashboard`: campaigns, leads and the activity log.
  - `/api`: token-protected JSON for integrations.
  - `/privacy` and `/data-deletion`: the pages Meta requires, served by the app itself.
  - `/export/leads.csv`: a revocable secret link for Google Sheets.
- Comment pipeline: a comment arrives by webhook or poll, is deduplicated by comment id, is matched to a campaign, then gets the public reply and the private reply, and is recorded.
- DM pipeline: a small state machine per conversation (link sent, awaiting email, re-asked once, done).
- Every action is idempotent and logged with an outcome and a reason: sent, skipped (already sent, expired, own comment, no campaign), or failed (with Meta's error).
- Dashboard access: an admin passphrase set during setup, stored hashed. Sign-in with the connected Instagram account can come later.
- Secrets (Meta app secret, tokens) live in Worker secrets or encrypted in D1, never in the repo.

## Setup for someone without the author's tools

1. **Deploy to Cloudflare** button: copies the repo into their GitHub, creates the D1 database, and gives them a URL. Pushes to their copy redeploy automatically.
2. **Open `/setup`**: a checklist that checks itself. For each Meta step it shows the exact value to paste (webhook URL, verify token, redirect URL, privacy URL) and turns green once the step really works. The Instagram tester invite gets its own screen, because it is the step people miss.
3. **Connect Instagram** from the checklist.
4. **Test**: comment the test keyword from another account and watch it arrive and the DM go out.
5. **Create the first campaign** in the dashboard.

The README also carries a "set this up with Claude" prompt for people who prefer to be walked through it. Updating a deployed copy (pulling fixes from this repo) must be documented and tested.

## Exports and integrations

- v0: CSV download; Google Sheets through `=IMPORTDATA("<secret link>")` (refreshes roughly hourly, revocable); the JSON API with a token, which is how a personal knowledge base or any other tool reads campaigns, leads and counts.
- Later: newsletter tools by pasted API key (Kit, Beehiiv, MailerLite), an outgoing webhook for Zapier or Make, and an MCP server so an AI assistant can run campaigns.

OwnChats knows nothing about any particular integration. Integrations call the API from their own side.

## Consent and data

- The email ask says what the person will receive.
- Each lead is stored with the consent wording shown and a timestamp, and can be deleted on request through the data-deletion route.

## Not in v0

Follow gate, Story reply triggers, Live comments, AI replies, a visual flow designer, several Instagram accounts, link click tracking, newsletter integrations, a hosted version.

## Open questions

- Must-have features: being researched on 2026-11-04 against what creators ask for and what existing tools offer. Adjust "Not in v0" from the result.
- Whether Standard Access is enough for private replies to strangers (see above). If it is not, App Review and Business Verification become part of setup, and the README must say so plainly.
