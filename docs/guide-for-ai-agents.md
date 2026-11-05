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
- Meta creates a default configuration: a system-user access token expiring Never, with `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `instagram_content_publish` and two ads permissions. Keep it as it is, and copy its Configuration ID.
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
- **DM keywords match anywhere in a DM.** With a common word as the keyword, a DM like "can we set up a call?" gets that campaign's link. Pick distinctive keywords, or turn the DM keyword off for that campaign.
- **Arming a Reel before it's posted.** Comments written before a campaign was created are ignored, and comments that arrive while it is off are skipped and not retried. Create the campaign before posting, switched off, then attach it to the Reel and switch it on as soon as the Reel is live. An agent can watch the account's latest posts and do this; on the first run it took 2 minutes after posting.
- **Google Sheets** shows `#REF!` until someone clicks Allow access in the sheet.
- **The export link and the API token** are stored encrypted. Get them from Settings in the dashboard; the values in the database are not usable.

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

Write to the database only for the fix below, and only with the person's OK.

## Answering a comment OwnChats missed

On the first night, someone commented "Set-up" when the spellings were SETUP and SET UP, and got nothing. It only showed up in the skipped comments. To answer such a comment:

1. Fix the cause first, usually a missing spelling: edit the campaign in the dashboard.
2. Check that the comment is less than 7 days old. After that, Meta refuses.
3. With the person's OK, mark the comment as not yet handled:

   ```sql
   UPDATE comments SET status = 'new', reason = NULL, campaign_id = NULL
   WHERE id = '<comment id>' AND status = 'skipped';
   ```

4. The Cron picks it up within a minute and sends the usual DM and public reply. Check that the row now says `done`.

If the comment was already answered once, Meta refuses the second private reply and the row says `failed`. Nothing is sent twice.

## Deleting someone's data

The person does it from Leads, "Delete someone's data". OwnChats clears the lead, the conversations, the log entries, and the text, username and id on each comment, keeping only each comment's id for up to 30 days, so the poll never takes it for a new comment.

Copies deployed before 2026-11-05 deleted the comment rows instead. The next poll then stored that person's comments again and tried to answer them; Meta refused the repeats, so nothing was sent twice. Update such a copy, then delete the person once more.

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

Not proven yet:

- **A tap on the opening button** reaching OwnChats from an account with no role. The only test ran while ManyChat still owned that DM thread, and the tap never arrived. A campaign without the button, which sends the link in the first DM, doesn't depend on it.
- **The token's "Never" expiry over months.** OwnChats checks the token daily and warns on `/setup` and the dashboard.
