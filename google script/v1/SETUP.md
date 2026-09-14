# SETUP — Sheet Mail Engine v2

## Install (10 minutes)
1. Open your Google Sheet → **Extensions ▸ Apps Script**. Replace all code with `Code.gs`. Save.
2. **Project Settings (⚙) ▸ Time zone** → `Asia/Kolkata`. Also **File ▸ Settings ▸ Time zone** in the Sheet → `Asia/Kolkata`.
3. (Recommended) In the editor: **Services (+) ▸ Gmail API ▸ Add**. Enables follow-ups inside the original thread. Without it, follow-ups go out as new emails (still tracked).
4. Reload the Sheet → menu **Mail Engine ▸ Setup / Repair Sheets**. Authorise when asked. Creates `Config`, `Sequence`, `Unsubscribed`, `Logs` and adds tracking columns to your recipients sheet (a sheet with a `Recipient` header is auto-detected and renamed `Recipients`).
5. Fill **Config**: `Your Full Name`, `Your Email`, `Your Phone Number`, `Your LinkedIn Profile`, optional `Sender Name`. Adjust `MAX_PER_DAY` to your Gmail quota (100 consumer, 1500 Workspace).
6. In Gmail, create one **Draft per Sequence step**. Subject must match `Sequence ▸ Draft Subject` exactly. Use `{{name}}`, `{{Role}}`, `{{company|your company}}`, `{{Your Full Name}}` … in subject and body. Attachments and inline images in the draft are sent with the first email.
7. Add recipients. Set `Scheduled Date` manually (`2026-09-15 09:30` or `15/09/2026 09:30`) **or** put a value in `Group` and run **Auto-Schedule Group…**.
8. **Mail Engine ▸ Run Deployment Test** → fix any ⚠.
9. Select a row → **Preview Email** and **Send Test To Me**.
10. **Install Trigger**. Done. Watch the `Logs` sheet.

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
`SCHEDULED` waiting · `SENDING` in flight · `SENT` sequence active · `COMPLETED` all steps sent, no reply · `INTERESTED` / `NOT_INTERESTED` / `REPLIED` reply classified (sequence stopped) · `UNSUBSCRIBED` asked to stop (added to `Unsubscribed`) · `BOUNCED` delivery failed (suppressed) · `INVALID` failed validation · `ERROR` see `Error` column.

## Known limits (honest)
- Emails do **not** appear in Gmail's *Scheduled* folder — Google exposes no API for that. The Sheet is the schedule.
- Address validation is syntax + disposable + role + MX; nobody can confirm a mailbox exists without sending. Bounces are caught and suppressed automatically.
- Sentiment is rule-based (fast, private, free). Swap `classifyReply_` for an LLM call if you need nuance.
- In-thread follow-ups drop attachments/inline images (text + HTML only).
- Type each `{{token}}` in Gmail in one go; changing formatting mid-token breaks it.
