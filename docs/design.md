# OwnChats design, v0

Written 2026-11-04, before any code. Update it as decisions change.

## What it is

Your own Instagram comment-to-DM bot. Someone comments a keyword on one of your Reels. OwnChats replies under the comment and sends them a DM with your link, and can ask for their email first. It runs on your own Cloudflare account (free tier) with your own Meta app, so there is no per-contact pricing and the leads are yours.

It was built for the author's own account and is shared as-is. Take it, change it, run it. No support is promised.

## Who it is for

- Creators who will follow a guided setup of about an hour to stop paying per contact.
- Not for people who want a one-click "Connect Instagram" with no setup. A hosted tool is the right choice for them. A hosted OwnChats would mean one Meta app through App Review for everyone, billing and support, and is out of scope.

## Scenarios in v0

1. **Keyword, then DM.** A comment containing the keyword on a chosen Reel, or on any post, gets a private reply DM and a public reply under the comment ("Sent! Check your DMs, it may be under message requests."). The DM opens with a button ("Send me the link"). The tap counts as the person replying, which is what lets OwnChats send a second message. The button can be turned off per campaign; the next step then goes in the first DM.
2. **The email, in one of three modes per campaign:**
   - **Link only.** The tap sends the link. No email ask.
   - **Link plus optional email.** The tap sends the link right away, with a line under it inviting the person to reply with their email ("Want more like this? Reply with your email and I'll add you to my newsletter. From Sam Lee, unsubscribe anytime. Who I am and my address: <privacy page>"). A valid email reply is saved as a lead with its consent wording and gets a thank-you. Anything else gets no re-ask and no gate, and silence is fine.
   - **Email first.** The tap brings the email question, which says what the person will receive. A valid email is saved and the link is sent. Anything else gets one re-ask; after a second miss the link is sent anyway, so nobody who commented leaves empty-handed.
3. **DM keyword.** Someone sends the keyword by DM (for example, their comment is older than 7 days) and gets the same flow, without the button, since their message already opened the conversation. Off by default and switched on per campaign, because the keyword matches anywhere in a DM: with TRAFFIC as the keyword, "how do I get more traffic?" would get the link.

Matching rules: case-insensitive, whole word, optional extra spellings per campaign (for example AGENTS and AGENT). In a keyword of several words, a space or a dash matches any spaces or dashes in the comment, so SET UP also matches "set-up", and the longer dashes some phone keyboards put in place of a typed double hyphen. Joining or splitting words ("setup" for SET UP) still needs its own spelling. A campaign on one chosen post can instead answer every comment ("any comment" mode); on all posts that would DM every commenter on the account, so it is not offered. A campaign watches one post or all posts, or waits for the next post (below); a campaign on one post wins over an all-posts campaign, and a keyword campaign wins over an any-comment one. Comments by the account owner are ignored, and so are comments written before the campaign was created, so arming a Reel never messages its old commenters. One DM per person per campaign, however many times they comment.

The next post: a campaign can be set up before its Reel exists, since comments arrive in the first minutes after posting. It then waits, answering nothing. Every minute while a campaign waits, the Cron reads the account's latest posts and attaches it to the first post published after the moment it was saved with that choice whose caption asks for its keyword: "comment", then the keyword, with only punctuation, emoji or "the word" between ("Comment AGENTS", "Comment the word AGENTS"). A caption that only mentions the word ("my agents bring traffic") doesn't count. So several campaigns can wait at once, each for its own Reel, and a keyword used on an older Reel doesn't get in the way: only posts published since the campaign started waiting count, and the old campaign stays on its old Reel. An any-comment campaign has no keyword to look for and takes the first new post. Saving a campaign again while it waits keeps the moment it started waiting. Comments that reached the post before it attached were skipped as matching no campaign. Those the campaign answers go back through the pipeline in the same Cron run, so posting first and attaching a minute later misses nobody. A campaign that is off still attaches, but answers nobody, and its early comments wait under To check.

Missed comments: a campaign's page lists, under To check, the skipped comments it could still answer. These are comments that came close to its keyword (a typo or two, a plural, joined or split words), match it now (they came in while it was off, or before a spelling was added), or were written before it started. Each one is less than 7 days old and comes from someone this campaign hasn't answered. Each has an Answer button, and near misses also get "Add the spelling and answer". Nothing is answered without the owner's click.

Public replies: each campaign has several reply variants (three by default). One is picked at random each time, never the same one twice in a row, because identical replies on a busy post are a known cause of Instagram comment bans. The public reply is posted only after the DM went out, so "Sent!" is always true.

Everything OwnChats sends is editable per campaign, and a new campaign ships with defaults that work without editing:
- the public reply variants
- the first DM and its button label
- the message with the link, and up to three links, each with its button label (without labels, the links go in the message instead)
- link plus optional email: the line added under the link, and the thank-you once the email is saved (empty: no thank-you)
- email first: the question, the reply when the answer is not an email (sent once), and the message that comes with the link once the email is saved
- the consent wording saved with each lead (empty: the question the person answered)
- an optional email tag, sent to the lead webhook (below) so the owner's email tool can pick the sequence

Any text can use `{name}` (the person's Instagram name when Meta shares it, otherwise their username, otherwise "there") and `{username}`. Before the person taps or writes, OwnChats knows only the username on their comment; it asks Meta for the name once, when they first tap or write.

## Meta constraints, checked 2026-11-04

- A private reply sends **one** message per comment, within **7 days** of the comment. More messages are allowed only after the person replies, and only within **24 hours** of their reply.
- Private replies are limited to 750 per hour per account.
- People who don't follow the account get the DM in their message requests, so the public reply says so.
- The account owner's own comments never trigger anything, so testing needs a second account.
- Connection: Instagram API with **Unified Login** (Facebook Login for Business with a configuration, no Facebook Page needed). Meta apps created since about 2026-10-08 can no longer choose "API setup with Instagram login", so a setup guide written for that path breaks on a new app. Unified Login needs a free Meta business portfolio, calls `graph.facebook.com`, and reportedly gives a token that does not expire. The account must be a Creator or Business account.
- The opening button is a button template sent as a private reply. Meta documents only plain text private replies, but other open-source tools send button templates this way. The first real run must confirm it; if it fails, the campaign falls back to sending the link in the first DM.
- Access level is not settled. Meta's platform overview says an app that serves only your own account needs Standard Access and no App Review. Meta's webhook docs say `comments` webhooks need Advanced Access. So OwnChats **polls** the comments of armed Reels every minute and also accepts webhooks when they arrive. The first real run must confirm that private replies reach commenters who have no role on the app.
- Tokens: Unified Login gives a "system-user" token. Set to expire "Never" in the app's configuration, it needs no refresh, and Meta offers no simple refresh for it anyway. OwnChats checks it once a day with `debug_token` and warns on `/setup` and the dashboard a week before any expiry Meta reports, or as soon as it stops working.
- Ids: the id on a comment and the id DMs come from may differ. A private reply returns the person's messaging id, and OwnChats keys the conversation on that, while still recognising the commenter's id, so the tap finds its conversation and a second comment is still "the same person".

## Architecture

- One Cloudflare Worker in TypeScript, a D1 database, and a Cron trigger every minute.
- Routes:
  - `/webhook`: Meta's verification handshake and incoming events.
  - `/setup`: the setup checklist (below).
  - `/dashboard`: campaigns, leads and the activity log. Campaigns are listed newest first, each with its post's cover image from the hourly post list. A campaign opens on its results: Instagram's numbers for its post, every comment on the post and what happened to it, why comments were skipped, the DMs from comments and from the DM keyword, and Meta's refusals. The form is behind Edit.
  - `/api`: token-protected JSON for integrations.
  - `/privacy` and `/data-deletion`: the pages Meta requires, served by the app itself.
  - `/export/leads.csv`: a revocable secret link for Google Sheets.
  - `/go/<id>`: campaign links, counted (below).
- Comment pipeline: a comment arrives by webhook or poll, is deduplicated by comment id, is matched to a campaign, then gets the private reply and, once that went out, the public reply, and is recorded. Private replies are capped at 700 an hour (Meta's limit is 750); comments over the cap wait in a queue that the Cron drains, still inside the 7-day window. A waiting comment keeps the campaign it was queued for. A comment the owner answers from To check goes back through the pipeline for the campaign they chose: its keyword and start date are not checked again, and every other rule still applies. Only comments skipped as "no matching campaign" or "written before the campaign started" can be handed over this way. OwnChats never sent those a private reply, so a click can't make it reply twice, and Meta refuses a second private reply anyway.
- Budget: the Workers free plan allows about 50 outgoing requests and 50 D1 queries per invocation. Each webhook delivery is its own invocation; the Cron run handles what it can and leaves the rest queued for the next minute. Comments that are skipped on sight are settled together in one batch.
- Post numbers: every hour the Cron lists the account's posts from the last 90 days (up to 150, three pages) into `media_stats`, and reads the follower, following and post counts into settings. Each run then reads Instagram's lifetime insights (views, reach, likes, comments, shares, saves) for the two most overdue posts. An active campaign's post is due every 15 minutes; any other post by its age: every 15 minutes in its first 2 days, hourly until day 8, every 6 hours until day 30, then daily. Pages and the API only read the table. A failed read keeps the last numbers. If Meta refuses for lack of `instagram_manage_insights`, the pages say how to add it, and a reconnect makes every post due again. The daily cleanup drops posts older than 90 days unless a campaign still watches them.
- Polling covers the posts that campaigns watch: each one-post campaign's Reel, and the 10 most recent posts when an all-posts campaign exists. A campaign waiting for the next post watches nothing until it is attached; while one waits, each Cron run starts by reading the post list (one Meta call) to attach it. Comments older than 7 days are ignored without a log entry.
- DM pipeline: a small state machine per person and campaign. States: opened (first DM with the button sent), awaiting email and re-asked once (email first), optional email (link sent, an email reply is still welcome), done. It sends only in answer to something the person just did (a tap or a message), so every follow-up is inside Meta's 24-hour window. While an optional email is pending, a message that is not an email is left alone, so a keyword for another campaign still works.
- Every action is idempotent and logged with an outcome and a reason: sent, skipped (already sent, expired, own comment, no campaign), or failed (with Meta's error).
- Lead webhook: when a campaign saves an email, a `lead.created` event is queued in `deliveries` and sent right after the DM that answers the email, so the person never waits on it. It is a signed POST to the URL the owner sets in Settings: HMAC-SHA256 over `<timestamp>.<raw body>` with the owner's secret, in `X-OwnChats-Signature`, a fresh timestamp and signature on each attempt, and one delivery id kept across retries. A 2xx is done; a 429, a 5xx, a timeout or no connection is retried after 1, 5 and 15 minutes, then 1, 3, 6 and 12 hours (8 attempts over about 22 hours); any other reply is final. The Cron sends what is due, up to five a run, even while Instagram is disconnected. Every attempt is logged. Deleting a person cancels their waiting deliveries and queues a `lead.deleted` for each of their emails. Once settled, a delivery's payload is emptied. The format is in `docs/lead-webhook.md`.
- Click counting: each campaign link in a DM goes out as `<base URL>/go/<id>`, with one random 16-character id per conversation and link (`tracked_links`), and the Worker answers with a 302 to the real link. The id is all the URL carries. A link sent again to the same person keeps its id. The first GET from a browser sets the link's first click and logs it; HEAD requests, link previews and crawlers (Meta's `facebookexternalhit` and `meta-*` agents, which draw Instagram's link previews, iMessage, Slack, Discord, search engines, scripts, and requests with no user agent) are redirected without counting. A campaign counts people who clicked at least one of its links, once each. Deleting a person deletes their ids; deleting a campaign detaches them, so links already sent keep working and count nowhere. Counting can be switched off in Settings; links then go out as they are.
- Dashboard access: an admin password, chosen on the Deploy to Cloudflare screen and kept as a Worker secret (`ADMIN_PASSWORD`). Choosing it at deploy time means nobody can claim a fresh deployment before its owner does. Sign-in with the connected Instagram account can come later.
- Secrets: the Meta app secret and the access token are entered in `/setup` after deploying (Meta needs the Worker's URL first, so they cannot be asked for on the deploy screen). They are stored in D1 encrypted with a key derived from `ADMIN_PASSWORD`, never in the repo. Changing the admin password means entering the Meta values again.

## Setup for someone without the author's tools

1. **Deploy to Cloudflare** button: copies the repo into their GitHub, creates the D1 database, and gives them a URL. Pushes to their copy redeploy automatically.
2. **Open `/setup`**: a checklist that checks itself. For each Meta step it shows the exact value to paste (webhook URL, verify token, redirect URL, privacy URL) and turns green once the step really works. The Instagram tester invite is explained where it matters: it lets a second account test before the app is published.
3. **Connect Instagram** from the checklist.
4. **Test**: comment the test keyword from another account and watch it arrive and the DM go out.
5. **Create the first campaign** in the dashboard.

The README also carries a prompt for people who prefer an AI agent to walk them through it, and `docs/guide-for-ai-agents.md` holds what the first real setup taught: what Meta's screens actually show, the problems and their fixes, diagnosing from the database, and updating a deployed copy. A Deploy-button copy shares no history with this repo, so updating applies the upstream diff since the copy was made; the guide's commands were tested on a real copy.

## Exports and integrations

- v0: CSV download; Google Sheets through `=IMPORTDATA("<secret link>")` (refreshes roughly hourly, revocable); the lead webhook, a signed POST of each new email (and each deletion) to a URL the owner sets, which an email tool, Zapier, Make or a small script of the owner's own can take from there; the JSON API with a token, which is how a personal knowledge base or any other tool reads campaigns, leads and counts. `/api/campaigns` includes each campaign's post numbers, `/api/posts` serves every post from the last 90 days with its numbers and campaigns (`since=` filters by posting date), and `/api/account` the follower count. So a tool that tracks the same video on several platforms takes Instagram's side from there. OwnChats keeps only the latest numbers; history belongs to that tool.
- Later: newsletter tools by pasted API key (Kit, Beehiiv, MailerLite), and an MCP server so an AI assistant can run campaigns.

OwnChats knows nothing about any particular integration. Integrations call the API, or take the webhook, from their own side.

## Consent and data

- The email ask says what the person will receive. The defaults also name the sender (the name in Settings, or the Instagram handle), link to the privacy page, which shows the name and mailing address from Settings, and say people can unsubscribe, as Canada's CASL asks of the line people answer; other countries' rules are close. Owners adjust the wording for where they and their audience are.
- Each lead is stored with the consent wording shown and a timestamp, and can be deleted on request through the data-deletion route. The lead webhook carries both, and a deletion is sent on as `lead.deleted`.
- Deleting a person removes their lead, conversations and log entries, and the text, username and id on each of their comments. Each comment keeps only its own id until the 30-day cleanup, so the poll and redelivered webhooks never take it for a new comment, store the person again or try to answer it twice. A new comment from them afterwards is a new request and is answered.

## Not in v0

Follow gate, Story reply triggers, Live comments, AI replies, a visual flow designer, several Instagram accounts, newsletter integrations by API key, a hosted version, the older Instagram Login path, sending the link anyway when someone taps the button but never answers the email ask, follow-up DMs or check-ins after the link.

## Open questions

Answered by the first real run on 2026-11-04 (one account, published app, Standard Access, no App Review, no Business Verification):

- Standard Access is enough: strangers' comments arrive by webhook and private replies reach them.
- A private reply can carry a button: both a link button and the opening button were delivered.
- Typed DMs (`messages`) from an account with no role on the app arrive once no other tool holds the conversation.
- `business_management` was not needed. Meta listed the account once the person was assigned to it in their business portfolio. The app itself was left without a portfolio.

Still open:

- Whether `messaging_postbacks` (the opening button's tap) arrive from strangers. The only test ran while ManyChat still held the DM thread, and the tap never arrived.
- Which user agent Instagram's own DM link preview really sends. Meta documents `facebookexternalhit` for previews across its apps, and the tests use it; the first live link will show whether a preview leaves the click count at zero.
- Whether Instagram treats DMs with links on the Worker's address differently from links to the destination. If it does, click counting can be switched off in Settings.

## Decisions

- 2026-11-04: Unified Login only, since every new Meta app gets it. The Graph host stays configurable so the older Instagram Login path can be added later.
- 2026-11-04: from the must-have research (ranked list in the author's notes), v0 adds the opening button, rotating public replies, all-posts targeting and any-comment mode. Follow gate, story triggers, newsletter push and click tracking stay out.
- 2026-11-04: the email ask is a per-campaign choice of three modes: link only, link plus optional email, email first. This replaces the earlier two scenarios (link, or email before the link).
- 2026-11-04: every outgoing text, button label and link is editable per campaign, with defaults and `{name}` / `{username}` placeholders. Public replies are picked at random rather than in turn.
- 2026-11-05: a campaign opens on its results rather than its form, so checking a Reel needs no database query. Comment counts cover 30 days, since comment rows are deleted after that. The DM funnel counts conversations, which last as long as the campaign. Taps in the last 24 hours, links sent again and failures come from the log, which keeps 90 days.
- 2026-11-05: the DM keyword is off by default for new campaigns, the setup test campaign included. It matches anywhere in a DM, so a keyword that is a common word answers ordinary conversations.
- 2026-11-05: missed comments are answered from the dashboard, on the owner's click, rather than with a database update. Near misses are found by edit distance (swapped letters count as one typo), by joined or split words, and by words that start with the keyword. Short keywords allow no typos, so GEAR doesn't flag "year" or "hear".
- 2026-11-06: each campaign shows its post's views and reach, read by the Cron and stored, so a page view costs no Meta call and a share of views can be shown next to the DMs. OwnChats stays a comment-to-DM tool: a library of every post, trends over time and other platforms (TikTok, where there is no comment-to-DM) belong in the owner's own tools, which read these numbers from the API.
- 2026-11-06: OwnChats is the owner's Instagram source for their other tools: it lists every post from the last 90 days and the follower count, and serves them through the API. Posts are read by age, because a post's numbers move fast in its first week and hardly at all after a month, and the Meta calls stay within one or two a minute.
- 2026-11-07: a campaign can wait for the next post, so it is ready before the Reel goes up without the owner, or an agent, watching for the post. It attaches to the first post published after it was saved whose caption says "Comment" and its keyword, checked every minute, and answers the comments that came in first without a click: they are on the post it was set up for. The caption, not the order of posting, decides, so several upcoming Reels can be armed at once; the call to comment is used because the keyword must be exact there anyway, while a hook or title changes between script, video and caption. The form reads the post list fresh, so a Reel posted a minute earlier is listed rather than mistaken for the next one. It is stored as a waiting time on the campaign, so a waiting campaign is never taken for an all-posts one.
- 2026-11-06: deleting someone by username takes two clicks. The first shows what that username matches (emails, conversations, comments, log entries) and deletes nothing; the second deletes exactly the ids it showed. A typo in a typed username could otherwise delete another real person's data at once. The Delete button on a lead stays one click behind a confirm, since it names the person already.
- 2026-11-07: new emails leave OwnChats by a signed webhook rather than by an integration with any one email tool, so any tool, Zapier, Make or a small script of the owner's can take them, and OwnChats stays vendor-neutral. The payload carries what consent law asks the owner to prove (the exact wording and the time), the Instagram name only when Meta shared it (never the username, so the email tool's own greeting applies), and an optional per-campaign email tag that picks the sequence. One delivery id is kept across retries so the receiver can drop repeats; retries last about a day, since a lead that arrives a day late is still worth having and one that never arrives is lost. A deletion is sent on as `lead.deleted`, so the copy in the email tool goes too. "Send a test lead" sends a lead marked as a test, exactly as a real one, so the email side can be checked end to end without a comment. The default email lines now name the sender, link to a page with their mailing address and say people can unsubscribe, because the earlier default ("Want more like this? Reply with your email") met none of what Canada's CASL asks.
- 2026-11-07: campaign links go through the Worker as `/go/<id>` so a campaign can count who clicked, the one step of the funnel OwnChats couldn't see: a link tap never reaches it from Instagram. One random id per conversation and link, so the URL names nobody and a forwarded link can't be traced to anyone by its address. Only each person's first click counts, and previews don't, so the number reads as people, not fetches. Follow-ups after the link (a check-in DM, answers to count, a "needs a reply" list) were considered alongside and left out on the author's decision.
- 2026-11-07: pages show times in the owner's time zone, chosen in Settings, with its abbreviation ("2026-11-06 09:03 EST"). Until one is saved they show UTC and the campaigns page says so; the Settings list starts on the browser's zone. The API, the CSV and the database keep UTC, so other tools never have to guess a zone. A setting rather than the browser's zone, so the pages read the same from any device, and for an agent reading them.
