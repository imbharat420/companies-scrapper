# PROMPT — Sheet Mail Engine (Gmail bulk sender, scheduler, follow-up sequencer)

> Paste this into an AI coding assistant (or hand it to an engineer) to build or extend the system. It is the spec `Code.gs` implements.

## Role & mode
You are the whole team (architect, engineer, security auditor, QA, red-teamer). Mode ULTRA: think deep, write short. Inspect before changing. Extend the existing `Code.gs`; do not fork. Label material claims VERIFIED / INFERRED / ASSUMED. Never fabricate test output.

## Goal
A single Google Apps Script bound to a Google Sheet that behaves like a lightweight GMass: personalised bulk email from Gmail Drafts, per-row scheduling, automatic follow-up sequences that stop on reply, reply sentiment classification, pre-send address validation, rate limiting, a kill switch, and human-readable logs — with zero external services and zero manual babysitting.

## Hard constraints (platform facts — design around them, don't fight them)
1. Apps Script execution ≤ 6 min → every run works within a **time budget** (270 s) and is **resumable**.
2. Gmail send quota: ~100/day consumer, ~1500/day Workspace → enforce `MAX_PER_DAY`, check `MailApp.getRemainingDailyQuota()`.
3. **No public Gmail API for scheduled send** (VERIFIED against the `users.messages.send` reference; a third-party claim of a beta `sendAt` param is UNVERIFIED and must not be relied on). Therefore the Sheet is the schedule; "Gmail Scheduled folder" is a non-goal. Provide an in-sheet dashboard instead.
4. **No SMTP-level verification** from Apps Script → validation = syntax + disposable-domain + role-address + MX lookup via DNS-over-HTTPS (`dns.google`), plus bounce detection after sending. Say so in docs; do not claim "deliverability guaranteed".
5. Time triggers are approximate (±1 min). One trigger only.
6. Gmail Drafts are the template store; matching is by exact subject.

## Data model
| Sheet | Purpose | Columns |
|---|---|---|
| `Recipients` | one row per person | `Recipient`, `Scheduled Date` (required) · `Group` · any custom columns (`name`, `Role`, `skills`, `experience`, `company`, …) · tracking: `Status`, `Step`, `Sent At`, `Next Follow-Up At`, `Thread ID`, `Reply Status`, `Reply At`, `Sentiment`, `Validation`, `Updated At`, `Error` (auto-created) |
| `Config` | settings **and** global variables | `Key`, `Value`, `Notes` — every key is also a `{{variable}}` (e.g. `Your Full Name`, `Your Email`, `Your Phone Number`, `Your LinkedIn Profile`) |
| `Sequence` | the series | `Step`, `Draft Subject`, `Delay Days`, `Delay Hours`, `Active`, `Notes` |
| `Unsubscribed` | suppression list | `Email`, `Reason`, `Added At` |
| `Logs` | observability | `Timestamp`, `Level`, `Execution`, `Row`, `Recipient`, `Event`, `Details` |

Variable resolution order: **row column → Config key → system** (`{{First Name}}`, `{{Today}}`, `{{Recipient}}`). Syntax `{{Key}}` or `{{Key|fallback}}`; keys are case- and whitespace-insensitive. Adding a variable = adding a column or a Config row. No code change.

## Features & acceptance criteria
1. **Scheduler** — `tick()` every minute. A row whose `Scheduled Date ≤ now` and status not terminal is sent within one tick when the window and limits allow. Dates accepted: Sheets Date, `DD/MM/YYYY HH:mm`, `YYYY-MM-DD HH:mm`, ISO.
2. **Non-blocking** — each tick: crash recovery → replies (bounded 40 % of remaining budget) → sends (≤ `BATCH_SIZE`). Never exceeds the budget; leftover work resumes next tick via a persisted cursor.
3. **Idempotent sending** — `SENDING` marker flushed before send; stale markers (> `STALE_SENDING_MINUTES`) are resolved by searching Gmail Sent: found → `SENT`, not found → re-queued. No duplicate sends under crash or overlapping triggers (script lock).
4. **Rate limiting / send window** — rolling `MAX_PER_HOUR`, `MAX_PER_DAY`, weekday list, `HH:mm` window, quota check. Outside window: wait, don't drop.
5. **Batch & series auto-scheduling** — menu action assigns `Scheduled Date` to a group (or all unscheduled rows) with spacing, jitter, window and per-day cap; series spacing is bounded below by `60/MAX_PER_HOUR`.
6. **Follow-ups** — Sequence steps 2..n fire `Delay` after the previous send if `Reply Status ∉ {REPLIED, BOUNCED}`; sent **in the original thread** when the Gmail advanced service is enabled (fallback: new email, both thread IDs tracked). Auto-replies (OOO) push the next step by `OOO_DELAY_DAYS` instead of stopping.
7. **Reply intelligence** — bounce (mailer-daemon / DSN subject) → `BOUNCED` + suppressed; auto-reply headers/subjects → `AUTO_REPLY`; otherwise sentiment on **unquoted text only**: POSITIVE → `INTERESTED`, NEGATIVE → `NOT_INTERESTED`, unsubscribe wording → `UNSUBSCRIBED` + suppression, else `REPLIED`. Any human reply stops the sequence. Classification lives in one function (`classifyReply_`) so an LLM can replace the rules later.
8. **Validation** — before first send (and via bulk menu): `VALID | INVALID_SYNTAX | DISPOSABLE | ROLE_ADDRESS | NO_MX | MX_UNKNOWN`. Blocks on hard failures; `ALLOW_RISKY` gates role addresses; DNS outage never blocks (`MX_UNKNOWN`). Results cached 6 h.
9. **Kill switches** — `Config.PAUSED`, per-row `PAUSE`/`SKIP`, Emergency Stop (pause + delete triggers). Pausing never loses state.
10. **Observability** — buffered log rows (one write per execution), auto-trimmed; Dashboard shows status counts, hourly/daily usage, quota, window, suppression size. Deployment Test verifies user, timezone, sheets, drafts, quota, API, DNS, trigger — without sending.
11. **Preview & test** — render any row's next step in a dialog with validation and missing-variable report; send it to yourself.

## Non-functional
- One read of the Recipients sheet per execution; writes only for changed cells, flushed at state transitions.
- Drafts loaded once per execution; MX results cached; send history in `ScriptProperties`.
- `STRICT_VARIABLES=TRUE` by default: an empty variable is an error, not a blank in a live email.
- Values are HTML-escaped when injected into HTML bodies.

## Decision defaults (state a reason to override)
Simple over clever · one trigger over many · Sheet as source of truth · rules before ML · GmailApp for first send (full fidelity: attachments, inline images), Gmail API only for threaded replies · fail closed on validation, fail open on DNS outage.

## Definition of done
Deployment Test passes; preview renders all `{{variables}}`; a 3-row test group with 1-minute spacing sends in order, marks `SENT`, captures `Thread ID`; replying from another account flips status within `REPLY_CHECK_MINUTES`; an unreplied row receives step 2 in-thread after the delay; `PAUSED=TRUE` stops sends within one tick; killing an execution mid-send never yields a duplicate.

## Red-team checklist (run before shipping any change)
Duplicate send on overlapping triggers? · Follow-up to someone who replied 30 s ago? · Variable leak (`{{name}}` literal in a live email)? · HTML injection from a sheet cell? · Follow-up sent to yourself via `thread.reply()`? · Timezone mismatch (sheet vs script vs Config)? · Quota exhaustion mid-batch? · Bounce not in original thread? · Rule-based sentiment false positive ("not interested in X but interested in Y")? · Log sheet growth?
