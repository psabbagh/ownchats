# Setting up a campaign from a caption

A tool or agent can set up the campaign for the next post without the dashboard. Give it the caption the post will carry, and OwnChats reads the keyword from that caption, so the keyword in the caption and the campaign's keyword can't differ.

It needs the **API write token**: dashboard, Settings, API write token, Create write token. It is shown once and starts with `ocw_`. It creates campaigns and checks captions, and nothing else. It can't read leads, and the read token (`oc_`) can't create anything. Keep it in your password manager and give it only to the tool that sets up campaigns.

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
| `link_label` | no | Its button label. Default "Open". |
| `link_title` | no | What the link leads to, sent to the lead webhook. |
| `email_tag` | no | Sent to the lead webhook. With one, the campaign asks for an email ("link plus optional email"); without one, it sends the link only. |
| `email_mode` | no | `"none"`, `"optional"` or `"first"`, to choose explicitly. |
| `opening_button` | no | The first DM's button label. Default "Send me the link"; empty string for no button. |
| `video_id` | no | Your id for the video, for example `SF-15`. |
| `name` | no | Default: the link title (or the keyword), then the video id. |
| `active` | no | Default `true`. |
| `dry_run` | no | `true` checks everything and saves nothing. |

Everything else starts as in the dashboard's "DM with a button, then ask for their email" flow: the default public replies, the first DM, the default email ask and its thank-you. The follow check and the DM keyword are off. All of it can be edited in the dashboard afterwards.

The answer is `201` with the campaign as `GET /api/campaigns` shows it (`counts` and `post` left out) and the caption check. With `dry_run`, it is `200` with `"dry_run": true` and `"id": null`. Read `campaign.warnings` before the post goes up: `email_ask_without_lead_webhook`, for example, means emails would stay in OwnChats.

Refusals, each with `error` in plain words:

- `422`: the caption asks for no keyword, or for several and `keyword` wasn't given, or `keyword` isn't one the caption asks for, or a field is invalid (`errors` lists each one).
- `409`: a campaign with the same `video_id` is already waiting (`campaign_id` names it), or the caption would also attach a campaign that is already waiting.
- `401`: no write token, or the read token.

Every campaign created this way is in the activity log as "API", "Campaign created through the API".
