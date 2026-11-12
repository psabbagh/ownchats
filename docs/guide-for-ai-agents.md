# OwnChats: a guide for AI agents

This file is for an AI agent (Claude Code, Codex, or any agent with a shell and a browser) helping someone set up, run, debug or update their own copy of OwnChats. People can read it too.

It records what happened during the first real setup and the first days live on the author's account, on 2026-11-04 and 05: what Meta's screens actually showed, what broke, and how each problem was found and fixed. Read `README.md` and `docs/design.md` first. This guide doesn't repeat them; it adds what you only learn by doing it.

## Ground rules

- **The person types every password, app secret and token.** Never ask for one, type one or print one. To check that two copies of a secret match, compare a truncated SHA-256 hash, never the values.
- **Don't create accounts** (GitHub, Cloudflare, Meta, a business portfolio). Walk the person through it.
- **Ask first before anything that messages a real person:** switching a campaign on, answering a comment again, a test that DMs someone else.
- **A push to their copy's `main` is a production deploy.** Cloudflare rebuilds and deploys on every push. Ask first.
- **The database holds real people's usernames, comments and emails.** Show them to the person in your conversation, and never paste them into an issue, commit, pull request or anything public.
- **Let the person do deletions** of people, leads and campaigns, from the dashboard.
- **Meta's dashboard changes often.** When a screen doesn't match, describe what you see and work it out with the person. Don't guess.

## Setup: what actually happened at each step

The `/setup` checklist in the app is the main path. Its wording was written before the first real run. Where this section disagrees with it, this section is newer.

### Deploy

- If the person already has a GitHub repository named `ownchats`, the Deploy to Cloudflare screen clashes on the name. Change the project name there (for example `ownchats-live`). The Worker and the new repository both take that name.
- The copy Cloudflare makes is a single import commit with no shared history with this repository, and without the `.github` folder. This matters for updates: see [Updating a copy](#updating-a-copy).
- The deploy creates the database and applies its migrations. Nothing to do by hand.

### Business portfolio

- Use a portfolio of the person's own. If their only one belongs to a company they work for, create a personal one; the app creation wizard has a "Create a business portfolio" link. Seeing the Instagram account in Meta Business Suite doesn't mean they have a portfolio.
- Add the Instagram account to the portfolio, then **assign the person to it**: business settings, Accounts, Instagram accounts, the account, Assign people, full control. Without this, Connect later says it worked but finds no account. Do it now, before Connect.

### Meta app

- A new app gets Unified Login only, and a banner says so. "API setup with Instagram login" is gone for apps created since about 2026-10-08, so guides for other tools written for that path don't apply.
- Meta creates a default configuration: a system-user access token expiring Never, with `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `instagram_content_publish` and two ads permissions. Keep it as it is, add `instagram_manage_insights` for views on each campaign (see [Views on each campaign](#views-on-each-campaign)), and copy its Configuration ID.
- The redirect URL goes on the use case's **API setup with Unified login** page, in its Redirect URL field, not in the Facebook Login for Business settings.
- Skip Meta's own "Generate access tokens" / "Add account" step on that page. It is for Instagram testers and shows role errors. OwnChats gets its token through Connect.
- `business_management` was not needed, and neither was Business Verification.

### Connect

- Meta asks the person to log in and pick the portfolio and the account. If OwnChats then finds no Instagram account (Meta answers error 100, subcode 33, on the account list), the person isn't assigned to the account in the portfolio. Assign them as above, then connect again.

### Webhooks

- Paste the callback URL and verify token from `/setup`, then subscribe to `comments`, `messages` and `messaging_postbacks`. `/setup` turns green once Meta has verified the callback and the account is subscribed.

### Publish

- Put the privacy, terms and data-deletion addresses in App settings, Basic. Meta's Publish page itself listed only the privacy policy URL. After that, Publish worked at once: no App Review, no Business Verification.
- In Development mode only people with a role on the app get through, so publish before testing with an account that has no role.

### Test

- The account owner's own comments never trigger anything. Test from a second account with no role on the app.
- What to expect, measured on the first run: the comment reaches OwnChats by webhook within about a second, the DM goes out 3 to 4 seconds after the comment, and the public reply about 2 seconds after the DM. The poll every minute is the backup when a webhook is missed.
- When the test is done, turn the test campaign off. An open conversation (one waiting for a tap) takes that person's next DM as their answer. On the first run, a leftover test conversation answered a DM sent 13 hours later with "reply with your email".

## Moving from ManyChat or another tool

- Instagram allows one private reply per comment. For each Reel, switch the old tool's trigger off first, then switch the OwnChats campaign on.
- While the old tool's Instagram channel is still connected, it owns the DM threads it started. On the first run, comments and private replies worked, but a button tap never reached OwnChats.
- Once its automations and default reply are off, disable the channel. In ManyChat: Settings, Instagram, **Disable Instagram Channel**, which can be undone with Enable. Don't use Remove, which deletes its Instagram subscribers. After disabling, a DM reached OwnChats and was answered within 2 seconds.
- If DMs stop reaching OwnChats later, check first whether the old tool's channel was switched back on.

## Running campaigns

- **Spellings.** Matching ignores case and needs the whole word. A space or dash in a keyword matches any spaces or dashes, so SET UP covers "set up" and "set-up". A joined or split word is a separate spelling: add both SETUP and SET UP. Add the doubled letters people type (AGENTSS). After the first day, open the campaign and look at its skipped comments for spellings you missed.
- **Shortcut keywords.** Settings, Shortcut keywords holds what the audience comments to mean "send it", such as 🙌. Every keyword campaign on one post answers them on top of its own keywords, campaigns that wait for the next post included once they attach. So when arming a campaign, don't add 🙌 to its keywords: check the setting instead, in Settings, as `shortcut_keywords` in `GET /api/campaigns`, or with `SELECT value FROM settings WHERE key = 'shortcut_keywords'` (stored as typed, comma-separated: `🙌, send it`). A comment with a campaign's own keyword still goes to that campaign. Campaigns on all posts don't answer shortcuts, a 🙌 under a post with no campaign gets nothing, and a shortcut never attaches a waiting campaign or counts as a DM keyword, even when a campaign lists it itself. Campaigns armed before the setting may list 🙌 one by one; that is harmless. The setting changes what every campaign answers, so set or change it only with the person's OK.
- **DM keywords match anywhere in a DM.** With a common word as the keyword, a DM like "can we set up a call?" gets that campaign's link. That is why the DM keyword is off by default for campaigns created since 2026-11-05. Switch it on only for distinctive keywords. Campaigns created earlier keep it on until it is unticked in Edit.
- **Arming a Reel before it's posted.** Pick "The next post you publish" in the campaign form and leave the campaign on. Within a minute of posting, the Cron attaches it to the first post published after the campaign was saved whose caption asks for its keyword ("Comment AGENTS", "Comment the word AGENTS"), and the comments that reached the post before that are answered then. Check the caption has that line, with the same spelling as the campaign: a caption that only mentions the word doesn't count, and the campaign keeps waiting. The campaign page says it is waiting, and when the last check ran. If a post goes up and no waiting campaign attaches to it, the Campaigns page says so under Needs you. If the Reel is already up, pick it from the list instead: the form reads the post list fresh, so a post published a minute ago is there. An agent arming campaigns from the database does the same with `UPDATE campaigns SET media_id = NULL, media_label = NULL, next_post_after = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE id = <id>`; no session needs to be running when the Reel goes up. Several upcoming Reels can be armed at once, as long as their keywords differ. A keyword used on an older Reel is fine: only posts published after arming count, and the old campaign stays on its old Reel. Comments written before a campaign was created are ignored, and comments that arrive while it is off are skipped and not retried; both show under the campaign's To check for 7 days, where the owner can answer them one by one.
- **Starting flows.** New campaign starts from a DM with the link (no button, no email ask), or from a DM with a button whose tap brings the link and asks for their email. In the second the email stays optional. Email first is a separate choice in the form, and someone who never answers it doesn't get the link. Get the person's OK on the email wording before a campaign asks for an email.
- **The follow check** is there for an owner who asks for it. Don't suggest it, and before switching it on tell them that [Meta's spam policy](https://transparency.meta.com/policies/community-standards/spam/) doesn't allow requiring people to follow to get access to specific content, so it can put the account at risk. It needs the first DM's button. Not following: "Follow me first" with an "I'm following" button, one more ask, then the link either way. If Meta's check fails, the link goes out, and the log shows it under Follow check. The campaign page shows who already followed, who was asked and who followed after the ask. Before relying on it, test it from a second account that doesn't follow the person: comment, tap, see the ask, follow, tap "I'm following", get the link. An agent arming a campaign from the database sets `follow_check = 1` and keeps `opening_button` non-empty.
- **Google Sheets** shows `#REF!` until someone clicks Allow access in the sheet.
- **The export link and the API token** are stored encrypted. Get them from Settings in the dashboard; the values in the database are not usable.
- **The email question's wording.** Since the 2026-11-11 update, new campaigns' email lines say what people will get and that they can unsubscribe, and the thank-you carries a Privacy button to `/privacy` (which shows the name and mailing address from Settings, "You, on the privacy page"). They no longer name the sender or link the address in the ask itself: the DM comes from the sender's own account. Some anti-spam laws ask for both when consent is requested, so tell the person this and let them add to the wording if they want. Campaigns created before the update keep their wording: help the person add their name and address in Settings, then edit each campaign's lines, with their OK on the wording. Point out that rules differ by country.
- **When the email ask is sent.** In "link plus optional email", the link goes out alone and the ask follows as its own message when the person first opens the link, within 24 hours of their tap. If they never open it, or open it later, nothing is asked. Without the first DM's button, or with click counting off, the ask goes under the link in the same message.
- **Link clicks.** Campaign links go out as `<their OwnChats address>/go/<id>`, so a DM you see in Instagram shows that address, not the destination. That is expected. A person's first click counts; previews don't. If DMs with these links seem to stop arriving, switch counting off under Settings, Link clicks, and tell the person what you saw. To show the person's own domain in DMs, add it to the Worker as a custom domain and open the dashboard there once. OwnChats then keeps it, even if the `workers.dev` address is opened later. Leave that address on, because links already sent and Meta's webhook use it. Before reconnecting Instagram, add the new domain's `/setup/callback` to the app's redirect addresses in Meta.

## The lead webhook

It sends each new email to the person's email tool, signed. The format is in [lead-webhook.md](lead-webhook.md). To set it up with the person:

1. They choose where it goes: their email tool's incoming webhook if it has one, Zapier or Make, or a small script of their own (for example another Worker) that checks the signature and calls their tool's API.
2. They make the signing secret with their password manager and type it into Settings, Lead webhook, with the URL, or set it as a Worker secret named `LEAD_WEBHOOK_SECRET` (`npx wrangler secret put LEAD_WEBHOOK_SECRET`, which prompts for it). The receiver needs the same secret, typed by them too. Never see, type or print it; to check two copies match, compare truncated SHA-256 hashes.
3. They click **Send a test lead** with their own email address and pick a campaign. The page says what the receiver answered. Check the email arrives in their inbox.

A failed delivery is retried for about a day (see lead-webhook.md). Every attempt is in Activity as "Lead webhook", and Settings lists the recent deliveries. Only emails saved after the webhook was set up are sent; earlier ones are in the CSV.

## Diagnosing with the database

The dashboard answers most questions: a campaign's page lists every comment on its post, what happened to it and why, and the activity log shows every step. For anything else, read the database from a clone of the person's copy, after `npx wrangler login` with their Cloudflare account. `DB` is the database binding in `wrangler.jsonc`, so these commands work whatever the database is called:

```bash
npx wrangler d1 execute DB --remote --command "SELECT id, name, media_id, keywords, active FROM campaigns"
```

Times are stored in milliseconds since 1970, UTC. Useful queries:

```sql
-- The newest comments and what happened to each
SELECT id, media_id, datetime(commented_at/1000, 'unixepoch') AS at_utc, source, status, reason, campaign_id, text
FROM comments ORDER BY commented_at DESC LIMIT 30;

-- Anything waiting or stuck
SELECT status, COUNT(*) FROM comments WHERE status IN ('new', 'queued', 'processing') GROUP BY status;

-- The log
SELECT datetime(at/1000, 'unixepoch') AS at_utc, kind, outcome, reason, campaign_id, detail
FROM activity ORDER BY id DESC LIMIT 30;

-- The DM state per person and campaign
SELECT campaign_id, state, first_sent_at IS NOT NULL AS dm_sent, datetime(updated_at/1000, 'unixepoch') AS updated_utc
FROM conversations ORDER BY id DESC LIMIT 30;

-- The lead webhook: what is waiting and what happened (the payload holds emails while pending; leave it out)
SELECT event, test, status, attempts, last_result, datetime(next_attempt_at/1000, 'unixepoch') AS next_utc,
  datetime(created_at/1000, 'unixepoch') AS created_utc
FROM deliveries ORDER BY created_at DESC LIMIT 20;

-- Link clicks: people who clicked at least once, per campaign
SELECT campaign_id, COUNT(DISTINCT conversation_id) AS people FROM tracked_links
WHERE first_clicked_at IS NOT NULL AND conversation_id IS NOT NULL GROUP BY campaign_id;
```

What a comment's status and reason mean:

| Status: reason | Meaning |
|---|---|
| done | DM sent and public reply posted |
| skipped: no matching campaign | No active campaign on that post matched the text. Check the spellings. |
| skipped: written before the campaign started | Expected: arming a Reel never messages its old commenters. |
| skipped: older than 7 days | Meta no longer allows a DM in answer to it. |
| skipped: own reply | OwnChats' own public reply coming back. Normal. |
| skipped: your own comment | The account owner commented. Test from another account. |
| skipped: this person already got this campaign's DM | One DM per person per campaign. |
| skipped: person deleted | The marker left when someone's data was deleted. |
| queued | Waiting for the hourly limit or the next run. |
| failed: Meta refused a private reply | Already answered once (by OwnChats or another tool), or too old. |
| failed: this comment can't be replied to | Public reply only. The comment was probably hidden or deleted. The DM still went out, so nothing is needed. |
| failed: Instagram blocked this public reply | Public reply only, possibly Instagram's spam filter. The DM still went out. If it keeps happening with different people, Instagram may be limiting the account. |

Write to the database only for the fix below, and only with the person's OK.

## Answering a comment OwnChats missed

On the first night, someone commented "Set-up" when the spellings were SETUP and SET UP, and got nothing. It only showed up in the skipped comments. Now such comments are listed on the campaign's page, under **To check**, with the time left in Meta's 7-day window:

- near misses: a typo or two, a plural, joined or split words ("Set-up", "PROMTS", "work shop");
- comments that match now: they came in while the campaign was off, or before a spelling was added;
- comments written before the campaign started.

People who already got the campaign's DM aren't listed. To answer one, with the person's OK:

1. Switch the campaign on, if it's off.
2. Click **Answer**, or for a near miss **Add "SET-UP" and answer**, which also adds the spelling so the next one matches.
3. The page says what happened. Answered means the DM and public reply went out. If another tool already answered the comment, Meta refuses the second private reply, and nothing is sent.

Each comment can be answered once. A second click, or the form sent again, does nothing.

On a copy deployed before 2026-11-05, which has no To check list, mark the comment as not yet handled instead, after fixing the spelling in the campaign:

```sql
UPDATE comments SET status = 'new', reason = NULL, campaign_id = NULL
WHERE id = '<comment id>' AND status = 'skipped';
```

The Cron picks it up within a minute. Check that the row now says `done`, or `failed` if Meta refused.

## Deleting someone's data

The person does it from Leads, "Delete someone's data". The username only finds the person: OwnChats lists their emails and how many conversations, comments and log entries it holds, and deletes nothing until they click Delete their data. It then clears the lead, the conversations, the log entries, and the text, username and id on each comment, keeping only each comment's id for up to 30 days, so the poll never takes it for a new comment.

Copies deployed before 2026-11-05 deleted the comment rows instead. The next poll then stored that person's comments again and tried to answer them; Meta refused the repeats, so nothing was sent twice. Update such a copy, then delete the person once more.

## Views on each campaign

Since 2026-11-06 each campaign shows its post's views, reach, likes, comments, shares and saves, and what share of the views led to a DM. The Cron also lists every post from the last 90 days and the follower count each hour, and reads up to two posts' numbers a minute into the `media_stats` table: a campaign's post every 15 minutes, other posts by age (often while new, daily after a month). `GET /api/posts` and `GET /api/account` serve them to the person's other tools.

It needs `instagram_manage_insights` in the login configuration. Meta's default configuration (see Meta app above) may not include it. Without it the campaign page and the Campaigns home say so, and everything else works as before. To add it, the person edits the configuration in the app dashboard: the use case's **API setup with Unified login** page, or **Facebook Login for Business**, then **Configurations**, then **Edit**. Then they click **Reconnect** on `/setup`. Every post is read again within a few minutes.

Not yet tested on a real app. To check what happened:

```bash
npx wrangler d1 execute <database> --remote --command "SELECT media_id, views, reach, datetime(updated_at/1000,'unixepoch') AS updated, problem FROM media_stats"
```

`problem` is `missing permission` when Meta refused for lack of the permission, otherwise Meta's error.

## Updating a copy

`git pull upstream main` fails on a copy made with the Deploy button ("refusing to merge unrelated histories"), because the copy is a fresh import. Apply the changes made upstream since the copy was made instead. In a clone of the person's copy:

```bash
git remote add upstream https://github.com/psabbagh/ownchats.git   # once
git fetch upstream

# The upstream commit the copy matches: the one named in the last "Update from ownchats" commit,
# or, before the first update, the last upstream commit before the copy was made.
BASE=$(git log -1 --grep='^Update from ownchats ' --format=%s | awk '{print $4}' | tr -d ':')
[ -n "$BASE" ] || BASE=$(git rev-list -1 --before="$(git log --reverse --format=%cI | head -1)" upstream/main)

# Check: only package.json and wrangler.jsonc (the name and the database id) and .github should differ.
git diff --stat "$BASE" HEAD

# Apply what changed upstream since then, test, and commit with the new base in the message.
if git diff --quiet "$BASE" upstream/main -- . ':(exclude).github'; then
  echo "Already up to date"
else
  git diff "$BASE" upstream/main -- . ':(exclude).github' | git apply --3way &&
    npm ci && npm run check && npm test &&
    git add -A && git commit -m "Update from ownchats $(git rev-parse --short upstream/main)"
fi
```

Pushing the commit deploys it (ask first). Cloudflare deploys within about a minute and applies database migrations itself; `npx wrangler deployments list --name <worker name>` shows the new version.

## What's proven so far

As of 2026-11-05, on one account, with a published app on Standard Access, without App Review or Business Verification:

- Comments from people with no role on the app arrive by webhook within about a second.
- Private replies reach them with a button: both a link button and the opening button (the one the person taps to get the link) showed up.
- Public replies post, and OwnChats ignores its own replies when they come back.
- Typed DMs from an account with no role arrive, so DM keywords and the email question work.
- The email chain works end to end: DM, email question, email saved, link, Leads page, Google Sheet.

On 2026-11-07, from a second account with no role on the app that didn't follow the author:

- The first DM landed in that account's message requests, as expected for someone who doesn't follow.
- **A tap on the opening button reaches OwnChats** (`messaging_postbacks`) with no other tool on the account, and the next message went out within 3 seconds of it arriving. So does a tap on "I'm following".
- **Meta answers `is_user_follow_business` and the name after such a tap.** It said "not following" twice while the account hadn't followed, and "follows" on the next tap, about half a minute after the account followed. Each check and its answer is in Activity under Follow check.

Not proven yet:

- **The token's "Never" expiry over months.** OwnChats checks the token daily and warns on `/setup` and the dashboard.
