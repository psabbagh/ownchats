# OwnChats

Your own Instagram comment-to-DM bot. Someone comments a keyword on your Reel, and OwnChats replies under the comment and sends them a DM with your link. It can ask for their email first. It runs free on your own Cloudflare account, so there is no per-contact pricing and the leads are yours.

**Status: being built in public. Nothing works yet.**

I built this for my own Instagram account and I'm sharing it as-is. Take it, change it, run it. I don't promise support.

## What v0 will do

- Reply under a keyword comment, then DM the link
- Ask for an email in the DM, re-ask once, then send the link anyway
- Answer the same keyword when someone sends it by DM
- Show campaigns, leads and an activity log in a small dashboard
- Export leads to CSV or straight into Google Sheets

The full plan is in [docs/design.md](docs/design.md).

## What you will need

- An Instagram Creator or Business account
- A Meta developer app (the setup checklist walks you through it)
- A Cloudflare account and a GitHub account

## License

[MIT](LICENSE)
