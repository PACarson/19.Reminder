# Architecture Review & Design Proposal — Time-Based Offset Reminder Engine

**Status:** PROPOSED / DRAFT — design only, not implemented, not merged into canonical governance files. Awaiting approval per your instruction ("only after the design is approved should implementation begin").
**Method:** re-examined the current architecture from source (`25_ReminderEngine.gs`, `22_QueryEngine.gs`, `21_SheetUtils.gs`, `20_EventBus.gs`, `40_Output.gs`, `11_Setup.gs`) rather than trusting the governance docs' description of it. Findings below are grounded in what the code actually does, cited by line/file where it matters.

---

## 0. Framing — this is not ADR-003's "Phase B," and here's why

This has to be established before anything else, because it changes what this document is and is not obligated to answer.

ADR-003's **Phase B (Reminder Scheduler)** is specifically: wire `TemporalEngine`'s recurrence calculation into Reminder OS so *recurring* reminders ("remind me every Monday") work. It comes with three explicit Open Questions (rule storage, integration with `checkReminders`, missed-occurrence recovery) that are deliberately unanswered "until Phase A has been implemented **and validated**" — validated meaning used by a real caller, which hasn't happened (`TemporalEngine` has zero callers today, confirmed in `00_Project_State.txt` and `00_File_Map.txt`).

What you've asked for here — reminders computed as `due_datetime − offset` for a task's own (generally non-recurring) due date, with multiple independent offsets per task — is a **different capability**, and ADR-004 already says so explicitly, in its own words, in the "V1 明确不支持" section:

> ✗ "提前N天/N小时提醒" 这种基于另一个日期反推的规则...不是 Temporal Engine 该管的"重复规律"计算

("Remind me N days/hours in advance"-style rules, derived by working backward from another date, are explicitly *not* what Temporal Engine is meant to handle.) Offset math (`due_datetime − offset_minutes`) is arithmetic, not recurrence calculation — there's no "next occurrence in an infinite series" problem here, because a task's due datetime doesn't repeat.

**Conclusion:** this initiative does **not** depend on `TemporalEngine`, does **not** need to resolve ADR-003's three Open Questions (they stay open, correctly, until real recurring-reminder need shows up), and is **not** subject to Part 1's "don't redesign Phase B" instruction — because it isn't Phase B. Framing it otherwise would have forced an artificial dependency on a zero-consumer module and reopened a deliberately-deferred question set for no reason.

**Naming/governance implication:** ADR-003 informally earmarks "ADR-005" for the real future Phase B design. This document should **not** claim that number. I'd suggest this become its own ADR once approved — you should pick the number, but I'd avoid 005 to prevent a future collision with literal Phase B. Everywhere below I call this the **Offset Reminder Engine** to keep it visibly distinct from "Scheduler"/"Phase B" in your own docs.

---

## 1. Architecture Review — current state

**What's sound and should be reused, not rebuilt:** the execution harness in `25_ReminderEngine.gs` is mature, five audit rounds deep, and solves real GAS constraints correctly — `LockService` single-instance guard, a time budget explicitly derived from `hard limit − worst-case single task − safety margin` (not a guessed number), chunked persistence via `SheetUtils.batchUpdateFieldsByKey_` (cost proportional to batch size, not table size), retry-on-lock-contention via a self-cleaning one-time trigger (capped, avoiding the 20-trigger quota), and decoupled functional-state-vs-audit-event persistence (Tasks fields land before Events, and Events failures don't roll back Tasks state). None of this needs to change in kind — it needs to be reused at a different polling cadence.

**What's actually insufficient, and why "don't assume it's correct" matters here:**

- **Polling frequency.** `11_Setup.gs` line 57: `ScriptApp.newTrigger('checkReminders').timeBased().everyHours(1).create()`. Hourly. The finest offset you've specified is 5 minutes. This is not tunable within the current design — it's a different cadence entirely. Confirmed insufficient; must be redesigned (§6).
- **Date model.** `SheetUtils.parseDueDate_` (line 517) special-cases pure `'YYYY-MM-DD'` strings as local midnight, and *falls back to native `Date` parsing for anything else* — which, per ES2015+, correctly handles a full ISO datetime-with-`T` in local time. So the parsing primitive is closer to datetime-ready than the rest of the system: the gap isn't parsing, it's that nothing upstream of it (`_shouldRemind`, the reminder-interval bucketing) does anything with time-of-day even when it's present.
- **Reminder identity.** Today a task has *one* implicit reminder cadence (`REMINDER_INTERVAL_HOURS` by priority, repeating). There's no concept of several independent, one-shot offset rules per task.
- **State model.** State is exactly two fields on `Tasks`: `reminder_count` (int) and `last_reminder_at` (timestamp). No pending/sent/dismissed/cancelled/failed — nothing that could represent "the -1-day reminder already fired but the -15-min one hasn't."
- **Channel coupling.** `_sendReminder` (line 597) builds a Telegram-specific `inline_keyboard` and calls `Output.sendMessage` directly — there's no seam between "decide to remind" and "which channel."
- **Reminder callback ambiguity.** `_sendReminder`'s inline buttons use `callback_data: 'task_snooze:' + task.task_id` — keyed by task only. With multiple concurrent reminder occurrences per task, "Snooze" becomes ambiguous (snooze which one?). Flagged in §2, not silently assumed away.

**Verdict:** the *domain model* of what a reminder is needs real extension; the *execution mechanics* around GAS quotas don't. Rebuild the former, reuse the latter.

---

## 2. Domain Boundary Validation

Re-confirmed against `00_Project_Constitution.gs` P1–P3, not assumed: Reminder OS's write surface today is exactly `reminder_count`/`last_reminder_at` on `Tasks`, plus append-only `Events`. It never writes to `ActiveTasks`/`ArchiveTasks`, and per P1's 2026-07-10 note, new Domain OS integrations are meant to add "a query branch," not a shared abstraction layer.

**This dictates the data model below, not the other way around:** since your own requirement states "Reminder OS never owns task data, never edits task data," and the existing Constitution already draws that exact line, all new offset/state/channel data must live in **new tables that Reminder OS creates and owns outright** — the same way Productivity OS owns `Tasks`/`ActiveTasks`. There's no boundary renegotiation needed here; the existing boundary already implies this answer.

**Read surface (unchanged mechanism, new fields):** `QueryEngine.getPendingTasks()` already returns every column present in `ActiveTasks` as a flat object (`22_QueryEngine.gs` line 94-99, `obj[h] = row[headerMap[h]]` for every header) — this is already forward-compatible with new columns. **No `QueryEngine` code change is required** to surface `due_time`/`due_datetime`, provided the column exists in the underlying sheet.

**Open dependency — flagging, not assuming:** this bundle contains only Reminder OS. I don't have Productivity OS's actual `Tasks`/`ActiveTasks` schema, so I cannot confirm whether `due_time` or `due_datetime` exists today, or in what shape (a single combined field vs. separate `due_date`+`due_time` columns). This design is written to tolerate either shape (§3 normalizes on read), but **this is a hard external dependency** — if neither field exists yet, this entire initiative is blocked on a Productivity OS schema addition, which Reminder OS cannot make itself (the same "never owns Task data" boundary applies to schema, not just row content). Worth confirming before implementation starts.

**Cross-project callback contract:** `00_Project_Constitution.gs` P6 documents that `task_done:`/`task_snooze:` callback parsing lives in Personal AI Core, not here. This design can widen the `callback_data` Reminder OS *emits* to include an occurrence identifier (so "Snooze" becomes unambiguous per-occurrence), but Core's webhook handler would need a matching update to parse it — I don't have Core's code in this bundle either. "Done" stays unambiguous regardless (completing a task cancels *all* its pending reminders as a natural consequence — no per-occurrence targeting needed there). Flagging this as a cross-project coordination item, not resolving it unilaterally.

---

## 2.1 Future-Proof Domain Boundary Validation — Reminder OS vs. Calendar OS

**Formal boundary, now governance rather than implicit:**

| Reminder OS owns | Belongs to a future Calendar OS instead |
|---|---|
| reminder rules | meetings |
| reminder schedule | calendar events |
| reminder queue | recurring calendar schedules |
| reminder history | time blocking |
| notification channels | availability analysis |
| reminder lifecycle | free/busy management |
| | Google Calendar synchronization |

**The reusable test, so future feature requests don't need this reasoning re-derived from scratch:** does the feature need to know **what else is happening at a given time** — a meeting, an event, someone's busy/free status? → Calendar OS's job. Does it only need to know **when to fire**, based on data another domain already owns (a task's `due_datetime`, a fixed clock window)? → Reminder OS's job. Reminder OS answers "when should a notification go out about something"; it never answers "what's on the calendar" or "is this moment available."

**Auditing every feature in this design against that test:**

- `ReminderRules`/`ReminderOccurrences`/`ReminderHistory`, the lifecycle states, retry/duplicate-prevention, the adapter contract — all pure reminder-delivery bookkeeping. None represents an event, a meeting, an attendee, a location, or a duration. Clean.
- Reading `due_datetime` from Productivity OS — this reads a **task's** deadline, not a calendar event. Reminder OS doesn't create, hold, or reason about calendar entries; it consumes a single timestamp another domain already owns, exactly as it consumes `chat_id` or `status` today. Clean, and this is worth generalizing (see worked example below).
- The auto-default-rules mechanism, config, trigger strategy, migration plan — infrastructure and configuration, no calendar concept anywhere in them. Clean.

**Two points close enough to the line that they need the distinction stated explicitly, not just assumed:**

1. **Quiet Hours is a fixed clock window, not availability analysis.** `QUIET_HOURS_START_HOUR`/`END_HOUR` (§5) never reads a calendar, never checks whether a meeting is happening, never computes busy/free — it's a static, configured "don't be noisy between these hours" gate, the same category of feature as a phone's Do Not Disturb schedule. If a future request asks for *"don't remind me while I'm actually in a meeting"* — that's dynamic, calendar-derived availability, and it belongs to Calendar OS, not an extension of Quiet Hours. The correct integration then would mirror the one already established with Productivity OS: Calendar OS computes and publishes a "currently busy" signal on a shared sheet, and Reminder OS's delivery gate reads that signal the same way it reads `due_datetime` today — it would never read Google Calendar or compute meeting overlaps itself.
2. **`TemporalEngine`'s "recurring schedule" is a date-math utility, not a "recurring calendar schedule."** It answers "when does this repeating pattern next trigger" with zero knowledge of meetings, attendees, locations, or durations — that's precisely why ADR-004 designed it to be reusable by Finance OS and Vehicle OS. If a future Calendar OS ever reuses `TemporalEngine` to compute "next Tuesday 3pm," that doesn't make `TemporalEngine` — or Reminder OS, which happens to use the same file today — an owner of calendar concepts. `TemporalEngine` is domain-agnostic Foundation-layer infrastructure; using it doesn't transfer ownership of what it's used *for*.

**Worked example, since an abstract rule is easier to apply with one:** *"remind me 15 minutes before my meeting"* is a plausible future request. If "my meeting" is already represented as a task-like record with a `due_datetime` — whether that's a Productivity OS task or a future Calendar OS publishing "next meeting starts at X" the same way Productivity OS publishes a due date — this is squarely Reminder OS's job, identical in shape to everything already designed here. It only crosses into Calendar OS territory the moment Reminder OS itself would need to read Google Calendar, resolve which meeting is "next," or handle an organizer's reschedule — none of which this design does or should do.

**Conclusion: no redesign required.** Nothing in this design currently crosses the boundary. The two points above get their distinction written down explicitly (here, and worth carrying into the Constitution — see the accompanying governance update) specifically so a *future* feature request doesn't quietly drift across it by extending Quiet Hours or `TemporalEngine` usage in a way that seems like a small step from where they already are.

---

## 3. Data Model (revised — Rule / Occurrence / History)

You asked me to evaluate Rule / Schedule / History / Queue (or another shape) and explain trade-offs rather than default to what exists. Here's the reasoning, including where it changed this round.

**Key design choice, unchanged: compute fire time fresh every poll; never store a future fire time that can go stale.**

Your hard requirement — *"never require users to manually edit reminder timestamps after changing task due time"* — has two possible architectures: (a) store a computed `fire_at`, and build invalidation logic to detect when the underlying due datetime changed and recompute; or (b) never store a future `fire_at` at all — recompute `due_datetime − offset` from the rule and the task's *current* due datetime on every single poll. (a) requires change-detection machinery for a problem (b) makes structurally impossible. **This is (b), and it's also your point 3** — Rules store only offsets, Occurrences are always recalculated from the latest due datetime. Worth being explicit that this wasn't a new constraint to design for; it was already the design, and your point 3 confirms it rather than changing it.

**Revising the earlier recommendation on Occurrence vs. History (your point 2).** The original version merged "queue" and "history" into one `ReminderOccurrences` table, reasoned narrowly from GAS Sheets not being indexed — splitting doesn't reduce query *cost* there. That reasoning was locally correct but missed the more important precedent already sitting in this exact codebase: Productivity OS doesn't use one table for both "currently relevant" and "everything ever" — it uses `Tasks` (full, ever-growing) plus `ActiveTasks` (a bounded projection of just what's operationally relevant), specifically because an ever-growing table scanned as if it were small is what caused `HIGH RISK 2`. A merged Occurrence/History table reproduces the shape of a problem this project already paid to fix once, just under a different table name. Your prioritization of this point is right, and the strongest argument for it isn't only future extensibility — it's consistency with a pattern this codebase has already proven it needs.

**Why not a separate Schedule table (unchanged reasoning):** still not recommended. Nothing here materializes a *future* schedule — occurrences only materialize once their threshold has already crossed "now," so there's nothing to store in advance regardless of how Occurrence and History are split.

**Recommendation: three tables.**

### `ReminderRules` (template — configuration only, no due-datetime-derived data)

| Column | Notes |
|---|---|
| `rule_id` | PK |
| `task_id` | FK into Productivity OS's `Tasks` — read-only reference, never written back |
| `chat_id` | denormalized, same pattern as `task.chat_id` today |
| `offset_minutes` | int; presets (5/10/15/30/45/60/90/120/1440) or custom |
| `offset_label` | human-readable, for message rendering |
| `channels` | JSON array, e.g. `["telegram"]` |
| `rule_status` | `active` \| `task_completed` \| `task_deleted` \| `removed` |
| `source` | `auto_default` \| `manual` — distinguishes an auto-generated rule from a hand-edited one |
| `resolved_fire_ats` | *(added during implementation, see archival note below)* JSON, `{channel: last-resolved fire_at}` — replaces the "check History" idempotency approach |
| `created_at` | |

### `ReminderOccurrences` (scheduled instance — HOT, BOUNDED, non-terminal states only)

Now genuinely bounded, not just targeted-read-bounded: a row lives here only while `pending`, `snoozed` (reserved), or `failed`-and-still-retrying. The moment a row reaches a terminal disposition it is archived into `ReminderHistory` and deleted from this table in the same pass (§5) — mirroring `ActiveTasks`'s shape, not just its spirit.

| Column | Notes |
|---|---|
| `idempotency_key` | PK — `rule_id + ':' + channel + ':' + floor(computed_fire_at / 60000)`. *(Implementation note: this replaces a separate `occurrence_id`; the key was already a perfectly good unique identity on its own.)* |
| `rule_id`, `task_id`, `chat_id`, `channel` | as before |
| `computed_fire_at` | due-datetime snapshot this occurrence was computed against, minute precision |
| `status` | `pending` \| `snoozed` *(reserved)* \| `failed` — only non-terminal values live here at rest |
| `attempt_count`, `last_attempt_at` | retry tracking |
| `snoozed_until` | *(reserved, nullable, always null in V1)* — see below |

### `ReminderHistory` (permanent, unbounded, append-only — mirrors `Tasks` itself)

| Column | Notes |
|---|---|
| `idempotency_key` | PK, identity carried over from `ReminderOccurrences` unchanged |
| `rule_id`, `task_id`, `chat_id`, `channel`, `computed_fire_at` | copied at archive time |
| `final_status` | `sent` \| `dismissed` \| `cancelled` \| `failed` |
| `attempt_count` | final count at resolution |
| `resolved_at`, `resolved_reason` | |
| `archived_at` | |

**Archival mechanism — revised during implementation (see `26_ReminderOffsetEngine.gs` header for the full reasoning).** Writing the actual code surfaced a real problem with the plan above: `SheetUtils.batchReadFieldsByKey_`'s own documentation states its read cost is proportional to the **target sheet's total row count**, not the number of keys being looked up — so "check `ReminderHistory` for this key" would scale with History's size, reintroducing the exact shape of `HIGH RISK 2` on a new table. Fix: dropped the separate `occurrence_id` (the `idempotency_key` was already a perfectly good unique identity — one less generated ID to track), and added `resolved_fire_ats` to `ReminderRules` (JSON, `{channel: last-resolved fire_at}`). The idempotency check now compares against this field on the rule object already sitting in memory from this poll's rule read — zero additional Sheet reads, and **`ReminderHistory` is never read during normal operation**, only ever written to. This is a strictly stronger version of the bounded-hot-path property §3 already wanted, discovered by actually building it rather than by re-reading the design on paper.

`ReminderOccurrences` is still checked before creating a new row (catches anything still in-flight from a previous poll) — that check stays cheap because `ReminderOccurrences` itself is bounded, unlike `ReminderHistory`.

**SNOOZED — reserved, not implemented (your point 4).** Added `snoozed` to the status enum plus a companion `snoozed_until` field — a status alone can't represent "snoozed until when," so reserving the field alongside it is what makes the reservation actually usable later without a schema migration. Intended future semantics: `pending → snoozed` on a user action (a future third button, not V1's current Done/Snooze-1h pair), `snoozed → pending` once `snoozed_until` elapses. Nothing in this design currently writes or reads either — flagging that I've extended your ask slightly (the field, not just the enum value) since the status alone isn't meaningful without it; happy to strip the field back out if you'd rather reserve only the label.

**Default rule generation — config-driven, not hardcoded (your point 1). Constant confirmed, not `SecureConfig`.** `DEFAULT_REMINDER_OFFSETS_MINUTES` is a top-of-file named constant in `26_ReminderOffsetEngine.gs`, matching this codebase's existing convention for tunable parameters (`REMINDER_ADVANCE_HOURS`, `REMINDER_INTERVAL_HOURS`, `MAX_RETRY_ATTEMPTS` are all the same shape — a named constant, not a value buried in logic). Deliberately not `SecureConfig`: this is default system behavior, not a secret or environment value, so it belongs with everything else this codebase already tunes the same way. Default value `[1440, 60, 15]` (your own -1 day/-1 hour/-15 min example), with an empty array meaning "auto-generation disabled" — one config surface controls both the values and the on/off switch. If runtime tuning without a redeploy is ever actually needed, migrating this one constant to `SecureConfig` later is a small, contained change — no reason to pay that cost now for a need that hasn't shown up.

---

## 4. Reminder Lifecycle (revised — SNOOZED reserved, archival added)

```
                    ┌─────────┐
                    │ pending │ ← materialized once offset threshold crosses "now"
                    └────┬────┘
        ┌────────────────┼──────────────┬───────────────────┐
        ▼                ▼               ▼                    ▼
     [sent]         [cancelled]      [snoozed]            [failed]
        │                │          (RESERVED,           (retry, ×MAX_RETRY_ATTEMPTS)
        │                │        not implemented)             │
        │                │               │                     ▼
        │                │               │              [failed, terminal]
        │                │               │                     │
        └────────────────┴───────────────┴──── archived into ReminderHistory,
                                                deleted from ReminderOccurrences
```

- **pending → sent**: channel delivery confirmed successful (mirrors the existing `sendResult.ok` check).
- **pending → cancelled**: the task is no longer `PENDING` (done/deleted), detected by the task's *absence* from the next `getPendingTasks()` result — same detection mechanism already in use, no new signal needed.
- **pending → snoozed** *(reserved)*: no code path produces this yet — see §3.
- **snoozed → pending** *(reserved)*: intended to fire once `snoozed_until` elapses; not implemented.
- **pending → failed → pending**: retried on the next regular poll (not a dedicated retry trigger — see §7) up to a capped attempt count, then terminal `failed`.
- **pending → dismissed**: same status as `snoozed` in practice — reserved for a future button, no code path produces it in V1 either. Omitted from the diagram alongside `snoozed` for space, not because it's more real.
- **sent / cancelled / dismissed / failed(terminal)** all trigger archival into `ReminderHistory` in the same pass they're reached, then get deleted from `ReminderOccurrences` (§3). `snoozed` does **not** archive — it isn't terminal, it stays in the hot table until it resolves to something else. History itself is immutable once written.

---

## 5. Scheduling Algorithm (revised — archival step and Quiet Hours seam added)

Each poll (proposed every 5 minutes, §6):

1. Acquire `LockService` lock (reused as-is).
2. Read active `ReminderRules` (bounded set).
3. Read current `getPendingTasks()` (already returns due-datetime fields automatically, per §2).
4. For each rule whose `task_id` is **absent** from this poll's pending-task set: mark any `pending`/`snoozed` occurrences for it `cancelled`, retire the rule (`rule_status = task_completed`, then remove from the hot table per §3).
5. For each rule whose task **is** present: compute `fire_at = due_datetime − offset_minutes` fresh; compute `idempotency_key`; check **both** `ReminderOccurrences` and `ReminderHistory` for that key (§3) — if `fire_at <= now` and absent from both, materialize a new `pending` occurrence per configured channel.
6. For every occurrence due for a delivery attempt this pass (newly materialized in step 5, or `failed` under its retry cap): if Quiet Hours is enabled and `now` falls inside the configured window (below), skip the delivery attempt — leave it `pending`/`failed`, don't archive, pick it up on a later poll once outside the window. Otherwise, attempt delivery.
7. Archive anything that resolved this pass — write to `ReminderHistory`, delete from `ReminderOccurrences` (§3's archival mechanism), same batch flush.
8. Same time-budget-aware loop, chunked persistence, per-item `try/catch`, and per-send throttle as `checkReminders` today — reused wholesale, not reinvented.
9. Batch-publish new event types via `EventBus.publishBatch` (`REMINDER_SCHEDULED`, `REMINDER_DISMISSED`, `REMINDER_CANCELLED`, `REMINDER_FAILED` — new; `REMINDER_SENT` already exists).

---

### Quiet Hours (proposed, disabled by default — your point 6)

Worth reserving now rather than bolting on later: it's a small, contained gate on step 6 above, not a restructuring, and the Occurrence/History split from §3 already hands it a seam for free — "materialize" (step 5) and "attempt delivery" (step 6) were already separate steps once the archival redesign happened, so gating step 6 alone defers a send without losing the occurrence or risking double-materialization on the next poll.

**Config:** `QUIET_HOURS_START_HOUR` / `QUIET_HOURS_END_HOUR` (24h local time, e.g. `22` and `8`) — same sentinel convention as the default-offsets config in §3: unset/`null` means disabled. One config pattern reused across both features rather than a separate boolean per feature.

**Overdue-bypass question: deferred by decision, not left dangling.** Same disposition shape as Part 1's Finding 3 (`Object.freeze`) — there's no real usage data yet to justify picking either answer, so rather than guessing, the decision is explicitly postponed until Reminder OS has actually run for a while and there's real behavior to reason from. The re-trigger condition is exactly that: once real usage experience exists, come back and decide. Nothing about the config or algorithmic seam is blocked by this — both stay reserved and ready either way.

**Scope for this round:** reserve the config surface and the algorithmic seam (already free, per above). Not building the actual time-window check itself until you confirm you want it active in V1 — turning it on later is a small, local change specifically because the seam already exists; there's nothing to retrofit.

---

## 6. Apps Script Trigger Strategy

Replace the fixed hourly cadence with `ScriptApp.newTrigger('checkOffsetReminders').timeBased().everyMinutes(5).create()` — the finest granularity GAS's time-driven triggers support, matching your finest offset option.

**Decision point for you, not resolved unilaterally:** should this be a *new*, separately-triggered function (`checkOffsetReminders`, running alongside the existing hourly `checkReminders`), or should the two be unified into one trigger now? Trade-off: separate = safer incremental rollout, V1's existing interval-repeat behavior keeps running untouched, you can bake in the new system in parallel before deciding whether to retire the old one; unified = cleaner long-term (one trigger, one mental model) but a riskier single cutover of already-audited, currently-working behavior. **I'd default to separate** given the conservative instruction governing this whole review, but this is genuinely your call since it affects how V1's existing behavior relates to the new system.

**Quota check, done explicitly since GAS trigger quota is a first-class concern in this codebase:** current permanent triggers = 1 (`checkReminders`, hourly) + occasional short-lived, self-cleaning retry triggers (capped at `MAX_RETRY_ATTEMPTS`). Adding one permanent 5-minute trigger → 2 permanent + occasional retries, comfortably under the 20-trigger hard limit.

---

## 7. Retry Strategy

Reuse the existing two-tier philosophy rather than inventing a third:

- **Lock-contention retry** (can't acquire the execution lock): exact reuse of the existing `_scheduleRetry_`/`_cleanupStaleRetryTrigger_` pattern — one-time trigger, capped attempts, self-cleaning.
- **Send-failure retry** (channel delivery failed): tracked via `attempt_count` on the occurrence row itself. Moving from hourly to 5-minute polling makes this simpler than V1's mechanism, not more complex — a `failed` occurrence under its retry cap is naturally retried on the *next regular poll* (5 minutes later), with no need for a separate dedicated retry-trigger mechanism for this tier the way V1 needs one for lock contention.

---

## 8. Duplicate Prevention

Primary mechanism is the idempotency key described in §3 — a row's existence in **either** `ReminderOccurrences` (in flight) or `ReminderHistory` (already resolved) is the durable claim that a given (rule, channel, due-snapshot) has been handled or is being handled. Secondary: the same `LockService` guard preventing overlapping poll executions.

**Not solved, and not claimed to be solved:** the same irreducible platform gap V1 already accepted — `UrlFetchApp`/Telegram's Bot API provide no way to distinguish "never sent" from "sent but the confirmation was lost," and no idempotency key at the API layer. This design doesn't relitigate that; it inherits the same accepted "at-least-once" trade-off and the same `ambiguousDelivery`-style diagnostic flagging already in `40_Output.gs`.

---

## 9. Migration Plan

- **New sheets:** `ReminderRules`, `ReminderOccurrences`, `ReminderHistory` — created and owned by Reminder OS directly (unlike `Tasks`/`ActiveTasks`), added to a setup step analogous to how Productivity OS's `setupSheets()` creates its own tables.
- **No backfill required.** V1's `reminder_count`/`last_reminder_at` on `Tasks` is untouched and independent — a different mechanism that can coexist unmodified unless/until you decide to retire it.
- **Rollout:** contingent on the §6 decision. If separate triggers, run both systems in parallel for a bake-in period with no cutover risk to the existing, already-hardened V1 path.
- **Config:** minimal additions only (e.g., a default channel), per the conservative instruction — no new config surface beyond what's actually needed for Telegram-only V1.

---

## 10. Universal Domain OS Blueprint Alignment

Checked this design against the fuller Blueprint (more granular than the 6-category version `00_ADR_001` currently documents locally for this project — Foundation/Runtime/Integration each split into more sub-categories). Every sub-category gets an explicit answer below: mapped to a concrete component, or marked not applicable with a stated reason. Nothing is left implicit, and no placeholder files get created just to fill a box — that would be exactly the complexity-without-benefit the conservative instruction warns against.

### 0. Governance
Unchanged from §0/§9: Constitution gets a scope note at ratification (not before), Project State updates once implemented, File Map is the table below, ADR is this document once approved (number TBD, not 005).

### 1. Foundation
- **Configuration** — two new named constants beyond §9's migration plan, both following the existing top-of-file convention rather than `SecureConfig`: `DEFAULT_REMINDER_OFFSETS_MINUTES` (§3) and `QUIET_HOURS_START_HOUR`/`QUIET_HOURS_END_HOUR` (§5), both using an empty/unset value as their own disable switch.
- **Schema** — this is §3. No separate physical schema file: this project's existing convention documents schema in prose inside the owning engine file's header (see `21_SheetUtils.gs`, `20_EventBus.gs`), not a dedicated schema artifact. Following that precedent rather than introducing a new one.
- **Identity** — needs a concrete convention, and there's already one to reuse rather than invent: `EventBus._generateEventId_()` is `'EVT-' + Date.now() + '-' + random(1000)`. Proposing `rule_id = 'RULE-' + ...` and `occurrence_id = 'OCC-' + ...` — same shape. `ReminderHistory` does **not** get its own ID scheme — it carries the originating `occurrence_id` forward unchanged on archive (§3), so a resolved reminder has exactly one identity across its whole lifetime, not two.
- **Event Definitions** — formalizing what §5 only listed inline:

  | Event Type | Payload | Emitted when |
  |---|---|---|
  | `REMINDER_SCHEDULED` | `{ rule_id, task_id, occurrence_id, fire_at, channel }` | an occurrence materializes (§3, threshold crossed) |
  | `REMINDER_SENT` | `{ task_id, occurrence_id, sent_at }` | delivery confirmed (existing type, `occurrence_id` added) |
  | `REMINDER_DISMISSED` | `{ occurrence_id, task_id, dismissed_at }` | user-initiated dismissal (future button, not V1's current 2-button set) |
  | `REMINDER_CANCELLED` | `{ occurrence_id, task_id, rule_id, reason }` | task left `PENDING` before delivery, or superseded by a due-date change |
  | `REMINDER_FAILED` | `{ occurrence_id, task_id, channel, attempt_count, error }` | retries exhausted |

- **Permissions** — not applicable. Single-chat/personal in scope today, same as the rest of Reminder OS; no access-control model exists or is being introduced here.
- **Versioning** — no new mechanism. This project's existing practice for schema evolution is ADR-driven, not a `schema_version` column. Following that precedent rather than adding one speculatively.

### 2. Runtime
Re-decomposing §5 into these categories — a clarity exercise on top of what's already designed, not new code:
- **Request** — the one genuine gap this exercise surfaced. Full treatment below.
- **Planner** — computing which rules have crossed their fire threshold this poll (§5 steps 2–5).
- **Decision** — the per-occurrence gate: is the task still pending, is the occurrence within its retry budget, is `now` inside Quiet Hours if enabled (§5 steps 4 and 6).
- **User Confirmation** — not owned by Reminder OS. The nearest analog, Done/Snooze button responses, is parsed by Personal AI Core's webhook handler per Constitution P6; this project's role stops at emitting the buttons.
- **Execution** — the actual channel dispatch call once Decision clears it (§5 step 6).
- **Event** — `EventBus.publishBatch`, reused as-is.
- **Projection** — none in the strict CQRS sense: nothing here is asynchronously rebuilt from the event log. `ReminderHistory` is written directly as part of the same transaction that resolves an occurrence (§5 step 7), not derived from `EventBus` after the fact. If you'd rather treat that directly-written History table as this layer's Projection for blueprint-purity, that's a fair relabeling — it doesn't change any code, only which box it's filed under.
- **Query** — `QueryEngine.getPendingTasks()`, unchanged (§2).

**Request:** the design so far assumed `ReminderRules` rows exist without saying how they get created. Two mechanisms, deliberately not a third:
1. **Auto-generated defaults (primary).** The first time a task is observed with due-datetime info and zero existing rules, create a default set automatically — proposing exactly the set from your own original example, **-1 day / -1 hour / -15 minutes** — so the common case needs no configuration step at all.
2. **Direct sheet edit (for anything non-default).** Add/edit/remove rows in `ReminderRules` by hand, consistent with the fact that this entire project has no chat-based configuration UI for anything today.
3. **Deliberately excluded: a chat command interface** (e.g. "/remind 15m"). Reminder OS does not accept the Telegram webhook — Constitution P2 states this plainly, and parsing inbound commands is Personal AI Core's boundary, not this project's. Building one now would be new, unrequested cross-project surface area. Flagged as an open item below, not decided unilaterally.

### 3. Intelligence
Not applicable. Nothing in this initiative plans, predicts, or learns — it computes deterministic offsets and dispatches messages. A placeholder file here would be complexity added for a box that isn't real yet, same category of thing ADR-004 already declined once (the timezone parameter) and Part 1's Finding 3 disposition declined again.

### 4. Integration
- **Bridge** — not applicable. Constitution P1 already rejected this shape for Domain OS integration ("add a query branch," not "abstract a generic interface"); no reason to reopen it here.
- **Connectors** — none *within* Reminder OS; it doesn't call outward to anything. Cross-project note rather than a file here: Personal AI Core's existing `ReminderConnector` currently wraps a read-only Reminder OS with no writable API. Once `ReminderRules` exists and is directly editable, that connector's documented gap (seven of ten operations returning `BUSINESS_ERROR`) narrows — but updating it is Personal AI Core's file, out of scope for this document.
- **APIs / External Systems** — `40_Output.gs`, extended per the file table below.
- **Import / Export** — not applicable. Not requested, no current need.

### 5. Testing
- **Unit Tests** — `50_ReminderOffsetEngine_Tests.gs`, as already proposed.
- **Integration Tests** — worth adding, genuinely new value rather than relabeling: a mock-poll-cycle test that fakes a `getPendingTasks()` result and runs one full `checkOffsetReminders()` pass, asserting on the resulting occurrence rows. The bugs worth worrying about in this design live in the *interaction* between rules, current task state, and idempotency keys — not in any single function in isolation, so pure unit tests won't catch everything that matters.
- **Migration Tests** — not applicable. §9 already established no backfill is needed.
- **Validation** — folded into Unit Tests rather than a separate category, but worth stating the principle explicitly since it's the same thread running through Part 1's entire disposition review: reject invalid rule input (non-integer offset, negative offset, unrecognized channel) at rule-creation time, not three layers downstream at fire time.

### File Map (draft — not merged into `00_File_Map.txt`)

| File | Layer | Role |
|---|---|---|
| `26_ReminderOffsetEngine.gs` *(new)* | 2_Runtime — Planner + Decision + Execution | Rule/Occurrence/History storage, occurrence computation/lifecycle/archival, the algorithm in §5. Kept as one file rather than split by table or by Runtime sub-category, consistent with ADR-001's reasoning for not fragmenting `25_ReminderEngine.gs` — this is a genuinely distinct responsibility from V1's engine (hence a new file), but not one that benefits from internal fragmentation to mirror the blueprint 1:1. |
| `checkOffsetReminders()` *(new, global)* | thin trigger-bound forwarder | Mirrors the existing `checkReminders()` pattern exactly |
| `40_Output.gs` *(extended, not replaced)* | 4_Integration — APIs/External Systems | Explicit adapter contract per your point 5: `{ name, send(target, message, options) → {ok, ...} }`. `Output.send(channel, ...)` becomes a lookup into a small `CHANNEL_ADAPTERS` object literal (not a plugin registry or dynamic loader) and a call to the matching adapter's `.send()`. Only `telegram` is implemented, wrapping today's existing logic unchanged; Email/Push/Webhook are reserved shape only — ADR-003 Phase E reasoning still applies, no second channel exists yet, more than an interface would be dead code. |
| `50_ReminderOffsetEngine_Tests.gs` *(new)* | 5_Testing — Unit + Integration | Manual Logger.log PASS/FAIL style, matching `50_TemporalEngine_Tests.gs`; includes the mock-poll-cycle integration test above |
| New ADR *(number TBD, not 005)* | 0_Governance | This document, once approved |

**Explicitly not touched:** `22_QueryEngine.gs` (already forward-compatible with new columns, §2), `21_SheetUtils.gs` (existing batch functions cover every access pattern needed), `12_TemporalEngine.gs` (not a dependency, §0), `25_ReminderEngine.gs` (V1 left running independently pending the §6 decision).

---

## Decisions Confirmed

- **Default rule generation**: auto-generate `DEFAULT_REMINDER_OFFSETS_MINUTES` (default `[1440, 60, 15]`) for any task first seen with due-datetime info and no existing rules; config-driven, disabled by an empty array.
- **Rule / Occurrence / History separation**: confirmed, superseding the earlier two-table recommendation — matches the `Tasks`/`ActiveTasks` precedent, keeps the hot table bounded (§3, §4, §5).
- **Offset-only Rules, always-recomputed Occurrences**: already the design; no change needed (§3).
- **SNOOZED status**: reserved in the enum plus a `snoozed_until` field, not implemented (§3, §4).
- **Channel adapters**: explicit `{ name, send() }` contract behind a small lookup object; Telegram-only implemented (§10 file map).
- **Quiet Hours**: config and algorithmic seam reserved; the check itself not built for V1 (§5).
- **Quiet-Hours overdue-bypass**: explicitly deferred, not decided now — same disposition shape as Part 1's Finding 3: no real usage data exists yet to justify either answer, so the decision waits until Reminder OS has actually run and there's real behavior to reason from. Re-trigger condition: real usage experience (§5).
- **Default-offsets storage: `Constant`, not `SecureConfig`** — this is default system behavior, not a secret, so it belongs with every other tunable parameter in this codebase (`REMINDER_ADVANCE_HOURS`, `REMINDER_INTERVAL_HOURS`, `MAX_RETRY_ATTEMPTS`). Migrating to `SecureConfig` later, if redeploy-free tuning ever becomes a real need, is a small contained change — no reason to pay that cost now (§3).

## Open Items — all four remaining require external input, not further architectural judgment

1. Productivity OS's actual `due_time`/`due_datetime` schema (§2) — this design cannot be verified correct without it.
2. Separate vs. unified trigger for V1 vs. the new engine (§6).
3. Whether/how to extend the Telegram callback contract for per-occurrence Snooze, and coordinating that with Personal AI Core (§2).
4. ADR numbering for this document once approved.
