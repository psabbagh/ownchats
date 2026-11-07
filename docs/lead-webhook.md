# The lead webhook

OwnChats can send each new email it saves to a web address you choose, so your email tool can send what the person asked for. It knows nothing about any particular tool. Point it at your tool's incoming webhook, at Zapier or Make, or at a small script of your own that checks the signature and calls your tool's API.

Set it up in the dashboard under **Settings, Lead webhook**: the URL, and a signing secret of at least 16 characters (make it with a password manager and keep it there). The secret can instead be a Worker secret named `LEAD_WEBHOOK_SECRET`, which then wins over the one in Settings. **Send a test lead** posts a lead marked as a test to the address you type, so you can check the whole chain, through to the email arriving, without anyone commenting.

## When it sends

- **`lead.created`**: each time a campaign saves an email. If the same person gives another email for the same campaign, it is sent again with the new address and the same lead id.
- **`lead.deleted`**: for each of a person's emails when their data is deleted from the dashboard, so the copy in your tool can go too. A `lead.created` for them that was still waiting to be retried is cancelled.

Only emails saved after the webhook is set up are sent. Earlier ones are on the Leads page and in the CSV.

## The request

```http
POST <your URL>
Content-Type: application/json
User-Agent: OwnChats-Webhook/1
X-OwnChats-Event: lead.created
X-OwnChats-Delivery: 9b2e6c1e-4f0a-4c8e-9d1b-2f7a5e3c8a10
X-OwnChats-Timestamp: 1762524204
X-OwnChats-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>", keyed with the secret>
```

A new lead:

```json
{
  "event": "lead.created",
  "delivery_id": "9b2e6c1e-4f0a-4c8e-9d1b-2f7a5e3c8a10",
  "sent_at": "2026-11-07T14:03:24.000Z",
  "test": false,
  "lead": {
    "id": 42,
    "email": "person@example.com",
    "name": "Sam",
    "created_at": "2026-11-07T14:03:22.000Z"
  },
  "campaign": {
    "id": 3,
    "name": "SETUP",
    "email_tag": "setupGuide"
  },
  "consent": {
    "wording": "Want more like this? Reply with your email and I'll add you to my newsletter. From Sam Lee, unsubscribe anytime. Who I am and my address: https://ownchats.example.workers.dev/privacy",
    "given_at": "2026-11-07T14:03:22.000Z",
    "channel": "instagram_dm"
  }
}
```

A deletion:

```json
{
  "event": "lead.deleted",
  "delivery_id": "0f3c5a7e-2b1d-4e8f-a6c9-7d4b2e1f3a58",
  "sent_at": "2026-11-09T10:15:00.000Z",
  "test": false,
  "lead": { "id": 42, "email": "person@example.com" }
}
```

The fields:

- `delivery_id`: new for each event, and the same on every retry of it. Use it to ignore a repeat, for example as an idempotency key with your email tool.
- `sent_at`, `created_at`, `given_at`: ISO 8601 times in UTC.
- `test`: `true` only for leads sent with **Send a test lead**. Those have `lead.id` 0 and aren't saved in OwnChats; otherwise they are built exactly like a real lead, with the chosen campaign's name, email tag and consent wording. Treat them as real if you want to see the email arrive.
- `lead.name`: the person's Instagram name when Meta shared one, otherwise `null`. Never their username, and never a stand-in like "there", so your email can fall back to its own greeting.
- `campaign.email_tag`: the campaign's optional **Email tag** (campaign form, Email section), for picking which sequence or email to send. `null` when empty.
- `consent.wording`: the exact line the person answered (or the campaign's consent wording, if it has one), and `given_at` when they answered it. Keep both if your tool can: they are your proof of consent.

New fields may be added; existing ones won't change.

## Checking the signature

Compute the HMAC-SHA256 of the timestamp header, a full stop, and the raw request body exactly as received, keyed with your secret, in lowercase hex. Compare it with the signature header, after `v1=`, in constant time. Refuse the request if they differ, or if the timestamp is more than 5 minutes away from your clock. The timestamp and signature are made fresh on each attempt, so a retry passes this check.

On Cloudflare Workers, for example:

```js
export default {
  async fetch(request, env) {
    const body = await request.text();
    const timestamp = request.headers.get("x-ownchats-timestamp") ?? "";
    const signature = request.headers.get("x-ownchats-signature") ?? "";
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return new Response("stale", { status: 401 });
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.OWNCHATS_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`));
    const expected = "v1=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const a = new TextEncoder().encode(signature);
    const b = new TextEncoder().encode(expected);
    if (a.length !== b.length || !crypto.subtle.timingSafeEqual(a, b)) return new Response("bad signature", { status: 401 });

    const event = JSON.parse(body);
    // event.event is "lead.created" or "lead.deleted". Call your email tool here,
    // passing event.delivery_id as its idempotency key if it takes one.
    return new Response("ok");
  },
};
```

Zapier and Make can receive the webhook too, but checking the signature there takes extra steps. Without the check, anyone who learns the URL can post fake leads to it.

## Replies and retries

- **2xx**: delivered.
- **429, any 5xx, a timeout (10 seconds) or no connection**: tried again after 1 minute, 5 minutes, 15 minutes, 1 hour, 3 hours, 6 hours and 12 hours, so 8 attempts over about 22 hours, then given up.
- **Any other reply** (another 4xx, or a redirect, which isn't followed): given up at once. Fix the URL or the receiver; the lead is still on the Leads page.

Every attempt is in the dashboard's activity log, as "Lead webhook", with the delivery id and the start of your reply. Settings lists the recent deliveries. What a delivery carried is wiped once it is delivered or given up; the lead itself stays in Leads until you delete it.
