# Setting up a campaign from a caption

A tool or agent can set up the campaign for the next post without the dashboard. Give it the caption the post will carry, and OwnChats reads the keyword from that caption, so the keyword in the caption and the campaign's keyword can't differ.

It needs the **API write token**: dashboard, Settings, API write token, Create write token. It is shown once and starts with `ocw_`. It creates campaigns, renames them and changes their keywords, checks captions and sends test leads to the lead webhook ([lead-webhook.md](lead-webhook.md#send-a-test-lead-through-the-api)), and nothing else. It can't read leads, and the read token (`oc_`) can't create anything. Keep it in your password manager and give it only to the tool that sets up campaigns.

## Check a caption

`POST /api/campaigns/check` saves nothing, and takes either token.

```http
POST /api/campaigns/check
Authorization: Bearer <token>
Content-Type: application/json

{ "caption": "Check your website's SEO with Claude.\n\nComment SEO and I'll send you the guide.", "keywords": ["SEO", "SEOO"] }
```

Send `keywords` for a campaign not created yet, or `campaign_id` to check an existing campaign's keywords.

```json
{
  "keywords": ["SEO", "SEOO"],
  "caption_keywords": ["SEO"],
  "attaches": true,
  "matched_keyword": "SEO",
  "waiting_campaigns_it_would_attach": [],
  "posts_already_up": []
}
```

- `caption_keywords`: what the caption asks people to comment, as written ("Comment SEO" gives `SEO`, "Comment SET UP" gives `SET UP`, "comment 'set up'" gives `set up`). Empty when the caption only mentions a word.
- `attaches`: whether a campaign with these keywords, waiting for the next post, would attach to a post with this caption. It uses the same rule as the Cron: "comment", then the keyword, with only punctuation, emoji or "the word" between.
- `waiting_campaigns_it_would_attach`: campaigns already waiting that this caption would attach. A new campaign for the same post would then answer nobody, since the older campaign wins.
- `posts_already_up`: posts from the last two days with no campaign whose caption asks for these keywords. A waiting campaign only takes posts published after it was created, so if the post is already up, set the campaign on that post in the dashboard instead.

## Create the campaign

`POST /api/campaigns` needs the write token.

```http
POST /api/campaigns
Authorization: Bearer <write token>
Content-Type: application/json

{
  "caption": "Check your website's SEO with Claude.\n\nComment SEO and I'll send you the guide.",
  "spellings": ["SEOO", "S E O"],
  "link": "https://example.com/guides/seo",
  "link_title": "Check your website's SEO with Claude",
  "email_tag": "guideRequested",
  "video_id": "SF-15"
}
```

| Field | Required | Meaning |
|---|---|---|
| `caption` | yes | The caption the post will carry. The keyword is read from it. |
| `keyword` | no | Only when the caption asks for several keywords. It must be one of them. |
| `spellings` | no | Extra spellings, as a list. They don't have to be in the caption. |
| `link` | yes | The link the DM delivers. |
| `link_label` | no | Its button label. Default: the one in Settings, Defaults for new campaigns, or "Open". |
| `link_title` | no | What the link leads to. Shown on its own line under the link message when there is one link, and sent to the lead webhook. |
| `email_tag` | no | Sent to the lead webhook. With one, the campaign asks for an email ("link plus optional email"); without one, it sends the link only. |
| `email_mode` | no | `"none"`, `"optional"` or `"first"`, to choose explicitly. |
| `opening_button` | no | The first DM's button label. Default "Send me the link"; empty string for no button. |
| `video_id` | no | Your id for the video, for example `SF-15`. |
| `name` | no | Default: the link title (or the keyword), then the video id. |
| `active` | no | Default `true`. |
| `dry_run` | no | `true` checks everything and saves nothing. |

Everything else starts as in the dashboard's "DM with a button, then ask for their email" flow: the default public replies, the first DM, the message with the link, the default email ask and its thank-you (the owner's own from Settings, Defaults for new campaigns, where set). The follow check and the DM keyword are off. All of it can be edited in the dashboard afterwards.

The answer is `201` with the campaign as `GET /api/campaigns` shows it (`counts` and `post` left out) and the caption check. With `dry_run`, it is `200` with `"dry_run": true` and `"id": null`. Read `campaign.warnings` before the post goes up: `email_ask_without_lead_webhook`, for example, means emails would stay in OwnChats.

Refusals, each with `error` in plain words:

- `422`: the caption asks for no keyword, or for several and `keyword` wasn't given, or `keyword` isn't one the caption asks for, or a field is invalid (`errors` lists each one).
- `409`: a campaign with the same `video_id` is already waiting (`campaign_id` names it), or the caption would also attach a campaign that is already waiting.
- `401`: no write token, or the read token.

Every campaign created this way is in the activity log as "API", "Campaign created through the API".

## Change a campaign's name, link title or keywords

`POST /api/campaigns/<id>` changes an existing campaign's name, its link title (the dashboard's "What the first link leads to") and its keywords, for example when a video's hook changes after its campaign was armed, or to add the spellings people type for its keyword. It needs the write token, and changes nothing else on the campaign.

```http
POST /api/campaigns/23
Authorization: Bearer <write token>
Content-Type: application/json

{
  "name": "Turn Claude into a sales machine",
  "link_title": "Turn Claude into a sales machine"
}
```

To add spellings, send only those:

```http
POST /api/campaigns/25
Authorization: Bearer <write token>
Content-Type: application/json

{ "add_keywords": ["SET UP", "SETUPP", "SET-UP"] }
```

| Field | Required | Meaning |
|---|---|---|
| `name` | one of these | The campaign's new name. It can't be empty. |
| `link_title` | one of these | What the link leads to. Under 200 characters; an empty string removes the title. |
| `keywords` | one of these | The whole keyword list, replacing the one it has, as a list of strings. |
| `add_keywords` | one of these | Spellings to add to the list it has, as a list of strings. Ones it has already are skipped. |

A field left out keeps its value. Send `keywords` or `add_keywords`, not both. Names and titles are trimmed. Keywords are cleaned as the dashboard's keyword field cleans them: trimmed, runs of spaces made one, empty ones dropped, and a repeat dropped whatever its case (`setup` repeats `SETUP`), so the first spelling sent stays. Each keyword matches comments the way the dashboard's do: case doesn't matter, and a space or dash matches any run of spaces and dashes, so `SET UP` already answers "set-up"; extra spellings are still worth adding where people type them. Any other field is refused, so a caller can't believe it changed something it didn't.

The answer is `200` with the campaign as `GET /api/campaigns` shows it (`counts` and `post` left out). Refusals, each with `error` in plain words:

- `404`: no campaign with that id.
- `422`: no field sent, a field that isn't a string (or a list of strings for keywords), an empty name, a title too long or one that would make the message with the link too long, an empty keyword list, a keyword holding a comma or a line break (send each spelling as its own item), both `keywords` and `add_keywords`, keywords on a campaign that answers any comment, or a field other than these (`errors` lists each one).
- `409`: a keyword this call adds is already answered by another active keyword campaign on the same post (the same one post, both waiting for the next post, or both on all posts), either way round: `SET UP` clashes with `SET-UP` and with `SET UP NOW`. `error` names the campaign. The dashboard saves such overlaps and lets the older campaign win; the API refuses them, so an agent can't take another campaign's comments. Your shortcut keywords from Settings are shared by every campaign and never clash, and keywords the campaign already has are never checked.
- `401`: no write token, or the read token.

Each change is in the activity log as "API", with the old and new values.
