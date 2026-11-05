# OwnChats

An Instagram comment-to-DM bot that runs on one Cloudflare Worker with D1. The plan and its reasons are in `docs/design.md`; read it before changing behaviour, and update it when a decision changes.

Helping someone set up, run or update their own copy? Follow `docs/guide-for-ai-agents.md`. The rest of this file is for working on OwnChats itself, in its public repository.

## This repo is public

Pierre made it public from day one on purpose (2026-11-04), to build it in public. So everything committed is published the moment it is pushed.

- Never commit real Instagram usernames, comments, emails, account or app IDs, tokens or secrets. Tests and examples use invented data.
- Pierre's own campaigns, leads and keys live in his Cloudflare deployment and in 1Password, never here. Integrations with his other tools live in those tools, and call OwnChats' API.
- No client names, nothing about Pierre's businesses, and no material from paid courses.
- Scan staged changes for secrets before every commit.

## Secrets

Secrets live in 1Password and are loaded with `op run --env-file=<refs-file>`. A refs file holds only `op://` references and is safe to commit. Never put a secret on a command line, in a file or in output. To compare two values, print a truncated SHA-256 fingerprint.

## Conventions

- No attribution signatures, generated-by notes, co-author trailers or tool credits in commits, docs, code comments or anything published.
- Neutral, work-descriptive branch names, without assistant, provider or model names.
- No em dashes in prose a reader sees: README, docs, setup screens, DM and reply texts.
- Before merging a pull request or pushing a change that moves `main`, run `~/.claude/bin/premerge-check <pr-number | ref>` from this repo and proceed only on PASS. Details are in `~/.claude/ci-paused.md`.
