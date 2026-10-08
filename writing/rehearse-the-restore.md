---
title: Rehearse the restore, time the rollback
description: Why I time database restores and rollbacks before a release needs them, with a four-minute incident on this site and a Postgres restore drill as worked examples.
date: 2026-10-08
---

# Rehearse the restore, time the rollback

A backup you have never restored is a hope, not a backup. The same goes for a rollback you have never run. Both get used for the first time at the worst moment, by someone in a hurry, so I rehearse them before a release and write down how long they took.

## A four-minute incident on this site

On 6 October a release of this site went out at 22:23 UTC with a change to its security headers. It worked under the local development server. In production, the platform ignored one line of the header rules, so browsers received two content security policies, and the stricter one blocked the page's own stylesheet and script. The page rendered unstyled.

- **22:23** The release went out. The production smoke check, which compares the live headers with the ones the repository says it should serve, failed straight away.
- **22:25** One command rolled the site back to the previous version.
- **22:27** The fix was deployed, and the build gained a rule that refuses the kind of header file that caused it.

About four minutes in all. Two things made it short: a monitor that compares production with the repository rather than just checking for a 200, and a rollback that had been written down before it was needed. The [incident record](https://github.com/PVieira04/patrickjv-eng-site/blob/main/docs/06-operations.md#incidents) is public.

The lesson I took: local development is not production. After any change to headers, check the headers on the live site.

## What a rollback actually is

On Cloudflare Workers, a rollback is not a redeploy from a laptop. It is a new deployment that points at an earlier version. Two things follow from that:

- **It is fast.** Rehearsed on a staging environment for a product I work on, the earlier version was serving 17 seconds after the request, and rolling forward again took 14 seconds. A health check polled every 10 seconds saw no errors in between.
- **It is temporary.** The next build from the main branch replaces it. A rollback buys time; the fix still has to land on main, or the next merge quietly brings the bug back.

## A database restore drill

Code rolls back in seconds. Data does not, so the database gets its own drill. For a Postgres database on Neon, which supports point-in-time restore, the drill runs without touching anything shared:

1. Create a new, short-lived branch of the database to restore into, so the shared environment is never written to.
2. Restore that branch to a chosen moment, then compare its schema with the source. No difference means the restore is complete.
3. Prove it restores data, not just structure: plant some rows, delete one, restore to just after the deletion, and check that the kept rows survive and the deleted one stays gone.
4. Time the recovery, and record how much data it lost.

The last run recovered the database in **2 minutes 15 seconds with no rows lost**, and the shared environment was never touched.

One trap worth knowing. Asking Neon for a branch "at a timestamp" uses the project's default branch unless you create the branch from the one you mean first. A drill that restores the wrong history still looks like it worked, which is exactly why the planted-rows check is in the drill.

## What done looks like

Before a release candidate goes out, its release pack holds three numbers, measured rather than estimated: how long a restore takes, how much data it loses, and how long a rollback takes. They are rerun for each candidate, because the system they describe keeps changing.

None of this is hard. It is just easy to leave until the day it is needed.
