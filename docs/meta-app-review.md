# Meta App Review for OwnChats

How to get your OwnChats Meta app approved for Advanced Access, step by step, and whether you need to. Written 2026-11-21 from Meta's docs as they read that day (every claim links to its page) and from a real OwnChats deployment. Meta renames dashboard buttons often: where a label below comes from Meta's docs rather than from a screen someone clicked through, it says so.

You do every step yourself. Nothing here is submitted, changed or signed in to for you.

## Read this first: you probably don't need it

**Comment webhooks already reach OwnChats without Advanced Access.** On the author's deployment (a published app on Standard Access, no App Review, no Business Verification), over 99% of comments since webhooks were turned on arrived by webhook, a few hundred on a busy day, and fewer than one in a hundred came from the minute-by-minute poll. To check your own copy, run this against your database (it reads counts only):

```sql
SELECT date(received_at/1000, 'unixepoch') AS day,
       sum(source = 'webhook') AS by_webhook,
       sum(source = 'poll')    AS by_poll
FROM comments GROUP BY day ORDER BY day DESC LIMIT 14;
```

Why this works even though Meta's webhook setup page says "Advanced Access is required for `comments` and `live_comments` notifications" ([Webhooks setup](https://developers.facebook.com/documentation/instagram-platform/webhooks/setup)): access levels are about **who uses the app**, not which events arrive. Meta's [access levels page](https://developers.facebook.com/docs/graph-api/overview/access-levels) says Standard Access permissions "can only be requested from app users who have a role on the requesting app", and the [Instagram Platform overview](https://developers.facebook.com/docs/instagram-platform/overview) says: "If your app only serves your Instagram professional account or an account you manage, Standard Access is all your app needs." The app user is you, the account owner, and you have a role on your own app. Commenters are not app users; they never log in to it. The webhook setup page also requires the app to be published ("Live") and the account to be public, both of which OwnChats' setup already covers.

So the minute-by-minute comment poll is a backup that catches almost nothing. Cutting it back is a code change in OwnChats, and needs no approval from Meta.

**Advanced Access does not raise the limit behind error code 4.** Meta's [rate limiting page](https://developers.facebook.com/docs/graph-api/overview/rate-limiting) defines code 4 as the app-level limit: "Indicates that the app whose token is being used in the request has reached its rate limit." Its formula is "Calls within one hour = 200 * Number of Users", where users means unique daily active users of the app. That page ties access levels to rate limits only for the Ads APIs; nothing there or on the [access levels page](https://developers.facebook.com/docs/graph-api/overview/access-levels) says App Review raises the Platform limit. With one user (you), the app has about 200 calls an hour whatever its access level, so polling 14 to 18 Reels every minute (about 360 calls an hour) runs past it, and then DMs are refused along with everything else. Approval would not change that number; fewer calls would. The [error handling page](https://developers.facebook.com/docs/graph-api/guides/error-handling) says to "Wait and retry the operation, or examine your API request volume", and the rate limiting page recommends webhooks to reduce call volume.

**When App Review is worth doing:**

- Someone with no role on your app needs to connect their own Instagram account to it (a second brand, a client). That is exactly what Advanced Access is for: "If your app will be used by people who do not have a role on it, the permissions and features that your app requires will need Advanced Access" ([access levels](https://developers.facebook.com/docs/graph-api/overview/access-levels)).
- Meta starts enforcing the webhook page's wording for role holders too, and webhooks stop arriving. The query above, or "Last webhook" on the dashboard, would show it within a day.

If neither applies, stop here. The rest of this guide is for when one does.

## What Advanced Access costs

- **Business Verification.** "Advanced Access now requires Business Verification", and the app "must be connected to a Business that has completed Business Verification" ([Business Verification](https://developers.facebook.com/documentation/development/release/business-verification)). That means a registered business with documents that match its name, address and phone. If the app only serves people with a role on it, "you do not need to complete verification" (same page), which is why OwnChats never needed it.
- **Data handling questions** about data processors, the legal entity responsible for the data and government requests ([questions preview](https://developers.facebook.com/docs/development/release/data-handling-questions/questions-preview)).
- **A yearly Data Use Checkup** for apps with Advanced Access ([Data Use Checkup](https://developers.facebook.com/documentation/resp-plat-initiatives/individual-processes/data-use-checkup)).
- **Re-review on changes**: changing the app's settings after submission may require review again ([submission guide](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide)).
- **Time**: "It typically takes us less than one week to process your submission, and often takes only 2-3 days, but may take longer during peak periods" ([App Review introduction](https://developers.facebook.com/docs/app-review/introduction)). Business Verification comes first and has its own wait.

## Which permissions to request

OwnChats uses the **Instagram API with Facebook Login** (Facebook Login for Business, the "Unified login" use case), on `graph.facebook.com`. So the permissions are the `instagram_*` ones, not the Instagram Login `instagram_business_*` ones. Meta's [webhook fields page](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields) says Unified Login "uses the same permission checks as Facebook Login for Business".

Request Advanced Access for these, and only these:

| Permission | Why OwnChats needs it | Meta's docs |
| --- | --- | --- |
| `instagram_basic` | Reads the connected account's id and username, its post list, and each comment's author. | [Permissions reference](https://developers.facebook.com/docs/permissions/reference/instagram_basic) |
| `instagram_manage_comments` | Receives `comments` webhooks, reads comments on armed posts, posts the public reply. | [Permissions reference](https://developers.facebook.com/docs/permissions/reference/instagram_manage_comments), [webhook fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields) |
| `instagram_manage_messages` | Sends the private reply to a comment and the DMs that follow, and receives `messages` and `messaging_postbacks` webhooks. | [Permissions reference](https://developers.facebook.com/docs/permissions/reference/instagram_manage_messages), [webhook fields](https://developers.facebook.com/documentation/instagram-platform/webhooks/fields) |
| `instagram_manage_insights` | Only if you use views and reach on campaigns. | [Permissions reference](https://developers.facebook.com/docs/permissions/reference/instagram_manage_insights) |
| `pages_show_list`, `pages_read_engagement` | Listed by Meta as dependencies of the Instagram permissions above. Request them only if the dashboard asks. | [Permissions reference](https://developers.facebook.com/docs/permissions/reference/instagram_manage_comments) |

Leave out everything OwnChats doesn't call: `instagram_content_publish`, the ads permissions in Meta's default configuration, `business_management`. "Selecting unneeded permissions is a common reason for rejection during app review" ([Permissions reference](https://developers.facebook.com/docs/permissions/reference)). You can keep them in the login configuration; just don't request Advanced Access for them.

## Step by step

### 1. Prove each permission works (at least a day before)

"Request advanced access" stays greyed out until the app has made a successful call with that permission in the last 30 days, and the call can take up to 2 days to show in the logs ([submission guide](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide)). A running OwnChats already makes these calls: reading posts and comments, replying, and sending DMs. If you just set up, run the test on `/setup` (comment the test keyword from a second account) and wait a day.

### 2. Verify the business

In [Meta Business Suite](https://business.facebook.com/), open the business settings of the portfolio that owns the app and start verification there (Meta moves this button; search the settings for "verification"). Enter the legal name, address, phone and website exactly as on your documents, and upload what it asks for. Then connect the app to the verified portfolio: in the app dashboard, **App settings**, **Basic**, **Verification** ([Business Verification](https://developers.facebook.com/documentation/development/release/business-verification)). Only a business admin of the portfolio can do this.

### 3. Fill in App settings, Basic

[developers.facebook.com/apps](https://developers.facebook.com/apps), your app, **App settings**, **Basic**. Copy each address from step 6, Publish the app, on your OwnChats `/setup`:

| Field | What to paste |
| --- | --- |
| App icon | A 1024 x 1024 image ([submission guide](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide)). |
| Privacy policy URL | `https://<your OwnChats address>/privacy` |
| Terms of service URL | `https://<your OwnChats address>/terms` |
| User data deletion | Choose **Data deletion instructions URL**, then `https://<your OwnChats address>/data-deletion` |
| Category | Business and pages (or the closest one offered). |
| App purpose | "Yourself or your own business" |
| Contact email | An address you read. Meta writes there about the review. |

Open the three addresses in a private window first. Each must load without signing in.

### 4. Start the request

App dashboard, **App Review**, **Permissions and Features** ([submission guide](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide)). On the row of each permission in the table above, click **Request advanced access**. Then click **Continue the Request**. The dashboard walks through:

1. **Business verification**, if step 2 isn't connected yet.
2. **Data handling questions.** Answers for OwnChats as built: the data stays in your own Cloudflare account (a Worker and a D1 database), Cloudflare is the processor, you are the controller, nothing is sold or shared, and the lead webhook sends emails only to a tool you chose. Name your email tool too if you use the lead webhook.
3. **App settings**, already done in step 3.
4. **App verification**: how Meta can test the app. See [Reviewer access](#reviewer-access) below.
5. **Per permission**: a description and a screen recording. Paste the texts below and upload the recordings from the shot list.
6. **Submit for Review**, then accept the Platform Onboarding Terms.

### 5. Wait, then check

Meta writes to the contact email and shows the result under **App Review**, **Requests**. When approved, the permissions show "Advanced access" under **Permissions and Features**. Click **Reconnect** on OwnChats' `/setup`, so the token carries them.

If a permission is rejected, the reason is on the request. Fix only that, record again if asked, and resubmit.

## Reviewer access

Meta tests with "our own test accounts" and says "Do not include your personal Meta Technologies app account's credentials" ([submission guide](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide)). And "If we are unable to access your app to test it, your entire submission will be rejected" ([App Review introduction](https://developers.facebook.com/docs/app-review/introduction)).

Never give reviewers the admin password of your real OwnChats. Two safe options:

- **Test from the commenter's side (simplest).** Arm a test campaign on a public post with keyword `REVIEW` and leave it on during the review. Reviewers comment `REVIEW` from any Instagram account and get the DM and its button. Paste the instructions below.
- **A separate review copy.** Deploy a second OwnChats with its own throwaway admin password, connected to a test Instagram account, and give reviewers that address and password. Delete it after the review.

Text for the app verification step (commenter's side):

```text
OwnChats is a tool the account owner runs for their own Instagram professional account. It has no sign-up and no end-user login: the owner connects their account once with Facebook Login for Business, and people interact with it only through Instagram.

To test it:
1. Open this public Instagram post: <post URL>
2. From any Instagram account, comment the word REVIEW.
3. Within a few seconds the account replies to the comment publicly, and a direct message arrives (in Message requests if you do not follow the account), with a button.
4. Tap the button. The next message brings the link.

The screen recordings show the owner's side: connecting the account, setting up the reply, and the result in the dashboard.
```

## Use-case texts

Meta asks for a separate description per permission ("Each permission and feature must have its own description. Do not copy and paste", [submission guide](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide)), saying how it helps users, why the app needs it and how the data is used. Replace the parts in angle brackets.

**instagram_basic**

```text
OwnChats answers comments on the account owner's own Instagram posts with a private reply. It uses instagram_basic to read the connected professional account's ID and username, to list the account's recent posts so the owner can choose which post a reply campaign watches, and to identify who wrote a comment (their ID and username) so each person gets one reply. The username is shown to the owner in their dashboard next to the comment. Nothing is shared with third parties. Without this permission OwnChats cannot tell which account it is connected to or which post a comment belongs to.
```

**instagram_manage_comments**

```text
OwnChats answers comments on the account owner's own posts. The owner creates a campaign for a post with a keyword (for example "GUIDE"). When someone comments that keyword, OwnChats receives the comment through the comments webhook, sends that person a private reply, and posts a short public reply under their comment so they know to check their messages. It uses instagram_manage_comments to receive comment webhooks, to read the comments on the posts the owner chose (as a backup when a webhook is missed), and to post the public reply. Comments are kept in the owner's own database so each one is answered once, and are shown to the owner in their dashboard. Without this permission OwnChats cannot see or answer comments.
```

**instagram_manage_messages**

```text
After someone comments a campaign's keyword on the owner's post, OwnChats sends them one private reply to that comment, with a button. When they tap it, OwnChats sends the link they asked for, and may ask for their email if the owner set that up. It only sends messages in answer to something the person just did (a comment, a tap or a message), inside the 24-hour window. It uses instagram_manage_messages to send the private reply and those messages, and to receive the messages and messaging_postbacks webhooks for replies and button taps. Conversations are stored only in the owner's own database and shown to the owner. Without this permission OwnChats cannot deliver what the commenter asked for.
```

**instagram_manage_insights** (only if you request it)

```text
OwnChats shows the account owner how each campaign's post performed: views, reach, likes, comments, shares and saves, next to how many people the campaign answered. It uses instagram_manage_insights to read those lifetime numbers for the owner's own posts. They are shown only to the owner in their dashboard and API. Without this permission the owner cannot compare a post's reach with the replies it produced.
```

## Screencast shot list

Meta's rules ([screen recordings](https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings)): one recording per permission is clearest, each showing the full login "from logged-out to logged-in", the permission being granted, then the feature in use. English interface or captions. No audio: "our reviewers will not listen to it." 1080p or better. Short captions on screen help.

Before recording: sign out of Facebook in the browser, have a second Instagram account on your phone that has no role on the app, and arm a test campaign on a public post with keyword `REVIEW`.

**Shared opening (the same for every recording)**

1. OwnChats `/setup`, signed in to OwnChats. Caption: "The account owner connects their Instagram account."
2. Click **Connect Instagram** (or **Reconnect**).
3. Facebook login screen: log in.
4. Facebook Login for Business: pick the business portfolio and the Instagram account, and show the list of permissions being granted. Hold on it for 3 seconds.
5. Back on `/setup`: step 4 now says "Connected to @<your account>".

**instagram_basic**

6. Dashboard: the connected username at the top.
7. **New campaign**: the list of the account's recent posts to choose from. Pick one. Caption: "The owner's posts, read with instagram_basic."

**instagram_manage_comments**

6. Dashboard: the test campaign with keyword `REVIEW` on a post, switched on.
7. Phone (second account, screen mirrored or recorded): open the post and comment `REVIEW`.
8. Back in the dashboard, open the campaign: the comment appears in its list of comments with its author and what happened to it. Caption: "Comment received by webhook."
9. Phone: the public reply under the comment, in the Instagram app.

**instagram_manage_messages**

6. Same comment as above (you can record both permissions in one session, but upload a separate clip per permission).
7. Phone: the private reply arriving in the second account's messages (Message requests if it doesn't follow you), with its button.
8. Tap the button; the link message arrives.
9. Dashboard: the campaign's DMs section showing the message was sent and the tap received. Caption: "Messages sent by OwnChats with instagram_manage_messages."

**instagram_manage_insights** (only if requested)

6. Open a campaign: the post's views, reach, likes, comments, shares and saves. Caption: "Post insights, read with instagram_manage_insights."

Turn the test campaign off after recording, unless reviewers are testing from the commenter's side.

## Common reasons for rejection

From Meta's own pages:

- Permissions requested that the app doesn't use ([Permissions reference](https://developers.facebook.com/docs/permissions/reference)).
- A recording missing for a permission: "it may not be clear to our reviewers how to test it, and your submission will be rejected" ([screen recordings](https://developers.facebook.com/docs/app-review/submission-guide/screen-recordings)).
- Reviewers could not reach the app ([App Review introduction](https://developers.facebook.com/docs/app-review/introduction)).
- A use outside the permission's allowed usage ([submission guide](https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide)).

Meta's reference row for `instagram_manage_comments` describes a recording of publishing a photo post, which looks copied from `instagram_content_publish`. Record comments anyway: the permission's allowed usage is to "read, update and delete comments of Instagram Business accounts".
