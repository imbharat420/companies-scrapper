# SETUP — Sheet Mail Engine v2

## Install (10 minutes)
1. Open your Google Sheet → **Extensions ▸ Apps Script**. Replace all code with `Code.gs`. Then **File ▸ New ▸ HTML**, name it `Panel`, paste `Panel.html`. Save both.
2. **Project Settings (⚙) ▸ Time zone** → `Asia/Kolkata`. Also **File ▸ Settings ▸ Time zone** in the Sheet → `Asia/Kolkata`.
3. (Recommended) In the editor: **Services (+) ▸ Gmail API ▸ Add**. Enables follow-ups inside the original thread. Without it, follow-ups go out as new emails (still tracked).
4. Reload the Sheet → menu **Mail Engine ▸ Setup / Repair Sheets**. Authorise when asked. Creates `Config`, `Sequence`, `Unsubscribed`, `Logs` and adds tracking columns to your recipients sheet (a sheet with a `Recipient` header is auto-detected and renamed `Recipients`).
5. Fill **Config**: `Your Full Name`, `Your Email`, `Your Phone Number`, `Your LinkedIn Profile`, optional `Sender Name`. Adjust `MAX_PER_DAY` to your Gmail quota (100 consumer, 1500 Workspace).
6. In Gmail, create one **Draft per Sequence step** and one per **Responses** row (thanks / acknowledge / close). Subject must match `Sequence ▸ Draft Subject` exactly. Use `{{name}}`, `{{Role}}`, `{{company|your company}}`, `{{Your Full Name}}` … in subject and body. Attachments and inline images in the draft are sent with the first email.
7. Add recipients. Set `Scheduled Date` manually (`2026-09-15 09:30` or `15/09/2026 09:30`) **or** put a value in `Group` and run **Auto-Schedule Group…**.
8. **Mail Engine ▸ Run Deployment Test** → fix any ⚠.
9. Select a row → **Preview Email** and **Send Test To Me**.
10. **Install Trigger**. Done. Watch the `Logs` sheet.

## Full-screen app (recommended — you never need to look at the sheet)
Apps Script ▸ **Deploy ▸ New deployment** ▸ type **Web app** ▸ Execute as **Me** ▸ Who has access **Only myself** ▸ Deploy ▸ open the URL (also shown under Settings ▸ Full-screen URL). The same UI opens inside the sheet via **Mail Engine ▸ Open Panel**.

## The Panel (Mail Engine ▸ Open Panel)
| Page | What it does |
|---|---|
| Recipients | searchable, filterable, sortable table of everyone; add / edit / paste-import; multi-select bulk actions (schedule, send now, validate, pause, resume, retry, unschedule, draft follow-up, respond, skip, suppress, delete); per-row preview, test-send, open thread |
| Settings | every Config key as a typed control (toggles, numbers, time pickers, day checkboxes, dropdowns) + custom {{variables}}; install/remove trigger, repair sheets, deployment test, emergency stop |
| Logs | full log viewer: level filter, search, up to 3000 rows, auto-refresh, click a row for pretty-printed details, clear |
| Sequence & templates | edit follow-up steps and reply templates inline; one-click "Create Gmail draft" for any missing subject; copyable variable list |
| Dashboard | trigger state, due-now count, hourly/daily usage bars, Gmail quota, status/group/sentiment tables, sequence progress, next sends, next follow-ups, live log tail; Pause/Resume, Run tick, Install trigger |
| Schedule | pick **who** (unscheduled / group / selected rows / all), **when** (Now · +1 h · +3 h · Tomorrow same time · Tomorrow at window start · Next Monday · Next week · Custom), **spacing** (gap, emails per batch, pause between batches, per-day cap, respect send window, overwrite). **Preview** shows first/last/per-day before **Apply**. Edit the follow-up sequence inline. |
| Send now | force-send a scope immediately, ignoring Scheduled Date (still validated, suppressed, rate-limited). Overflow is queued as due-now for the trigger. |
| Replies & follow-ups | every reply with sentiment + snippet → **Draft in Gmail** or **Send** a Responses template into the thread. Every "no reply yet" row → **Draft step N in thread** (row becomes `MANUAL`, no auto follow-up) or stop/resume automatic follow-ups. |

## Daily operation
| Want to… | Do |
|---|---|
| Stop everything now | **EMERGENCY STOP** (pauses + removes trigger) |
| Pause / resume sending | **Pause Sending / Resume Sending** (replies keep being tracked) |
| Skip one person | type `PAUSE` (temporary) or `SKIP` (permanent) in their `Status` |
| Retry a row marked `ERROR` / `INVALID` | fix the cause, clear `Status` (and `Validation` if needed) |
| Add a variable | add a column to `Recipients` or a row to `Config`; use `{{Exact Header}}` |
| Add a follow-up | add a row in `Sequence`, create the matching Draft, set `Active=TRUE` |
| Change send hours | `SEND_WINDOW_START/END`, `SEND_DAYS` in Config |
| See what happened | `Logs` sheet (filter by `Row` or `Recipient`), **Dashboard** |

## Status meanings
`SCHEDULED` waiting · `MANUAL` you handle the thread (replies tracked, no auto follow-ups) · `SENDING` in flight · `SENT` sequence active · `COMPLETED` all steps sent, no reply · `INTERESTED` / `NOT_INTERESTED` / `REPLIED` reply classified (sequence stopped) · `UNSUBSCRIBED` asked to stop (added to `Unsubscribed`) · `BOUNCED` delivery failed (suppressed) · `INVALID` failed validation · `ERROR` see `Error` column.

## Known limits (honest)
- Emails do **not** appear in Gmail's *Scheduled* folder — Google exposes no API for that. The Sheet is the schedule.
- Address validation is syntax + disposable + role + MX; nobody can confirm a mailbox exists without sending. Bounces are caught and suppressed automatically.
- Sentiment is rule-based (fast, private, free). Swap `classifyReply_` for an LLM call if you need nuance.
- In-thread follow-ups drop attachments/inline images (text + HTML only).
- Type each `{{token}}` in Gmail in one go; changing formatting mid-token breaks it.

## Why "the scheduler didn't run"
1. **The date is in the future.** `2026-09-15 09:30` sends tomorrow at 09:30 — not now. Use **Send now** to force it, or preset **Now** in Schedule.
2. **No trigger.** Dashboard header must say RUNNING. Otherwise Install trigger.
3. **Window closed / paused / cap reached.** Dashboard ▸ "Due right now" vs "window CLOSED"; the Logs sheet says exactly why each tick skipped.
4. **Timezone mismatch** — Deployment Test warns if sheet, script and Config disagree.