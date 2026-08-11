# Grand Villaggio Hotel — Reception Handover System

A simple, spreadsheet-style web app that replaces the Excel reception
handover sheet. No logins, no complicated permissions — reception staff
open it, pick their name, and fill it in like the old sheet.

- **Frontend:** plain HTML/CSS/JS (`public/`) — no build step
- **Backend:** Cloudflare Worker (`worker/src/index.js`)
- **Database:** Cloudflare D1 (`worker/schema.sql`)
- **Hosting:** a single Cloudflare Worker serves both the static site and
  the `/api/*` endpoints, so there's only one thing to deploy

```
villaggio-handover/
├── public/              the app (served as static files)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── worker/
│   ├── src/index.js     API (Worker)
│   ├── schema.sql        D1 tables + seed settings
│   └── wrangler.toml
└── README.md
```

## 1. Prerequisites

- A Cloudflare account
- Node.js installed locally
- Wrangler CLI: `npm install -g wrangler`
- `wrangler login`

## 2. Create the D1 database

```bash
cd worker
wrangler d1 create villaggio-handover-db
```

This prints a `database_id`. Copy it into `worker/wrangler.toml`,
replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

## 3. Apply the schema

```bash
wrangler d1 execute villaggio-handover-db --file=./schema.sql --remote
```

This creates the six tables (`handovers`, `handover_items`,
`cash_denominations`, `foreign_currency`, `activity_logs`, `settings`)
and seeds `settings` with the six staff names, the AED 2,500 expected
petty cash, and the standard AED denomination list.

(Use `--local` instead of `--remote` first if you want to test with
`wrangler dev` before touching the live database.)

## 4. Deploy

```bash
wrangler deploy
```

Wrangler will print your live URL, e.g.
`https://villaggio-handover.<your-subdomain>.workers.dev`. Open it —
that's the whole app. The Worker serves `public/` for normal pages and
handles `/api/*` itself, so there is nothing else to configure.

To use a custom domain (e.g. `handover.grandvillaggio.com`), add a
route in the Cloudflare dashboard under your Worker's **Triggers** tab,
or add a `routes` entry to `wrangler.toml`.

### Local development

```bash
wrangler dev
```

This runs the Worker (and serves the static files) at
`http://localhost:8787`, backed by a local D1 instance.

## 5. Using the app

- **Reference Date / From / To** — at the top. Changing the date loads
  that day's handover. If nothing is saved for that date yet, the app
  asks **"Create from previous day"** or **"Start blank"** — it never
  creates or fills in a new date silently.
  - **Create from previous day** copies the previous day's cash count
    and any unresolved room items into a brand-new record (new IDs,
    own rows in every table). The source date is read-only during this
    — it is never edited or re-saved.
  - **Start blank** creates an empty record for that date only.
  - Opening a date that already has a saved handover always opens that
    exact record. It is never reset, recalculated, or overwritten with
    another date's data.
- **Handover Items** — add/remove rows freely, just like inserting rows
  in Excel.
- **Handover Notes** — free text for anything not tied to a specific room.
- **Cash Denomination** — enter quantities only; totals are calculated
  and locked (shown with a shaded background). Foreign currency rows
  live in the same table, right below the AED denominations — add as
  many as needed with **+ Add foreign currency**. Enter the currency
  label and the hotel's own rate; the AED total calculates itself.
- **Cash Calculation** — Credits, Give Backs, and Cash Posting are the
  only editable numbers here. Everything else (Cash in Hand, Total,
  Petty Cash, Difference) is calculated automatically using:

  ```
  Cash in Hand = sum of all denomination + foreign currency totals
  Total         = Cash in Hand + Credits
  Petty Cash    = Total − (Give Backs + Cash Posting)
  Difference    = Petty Cash − Expected Petty Cash
  ```

  Difference shows **EXCESS**, **SHORT**, or **BALANCED** automatically.
- **Everything autosaves** a moment after you stop typing — no Save
  button to remember. The status indicator in the top bar shows
  "Saving…" then "Saved ✓".
- **Mark complete** — toggle in the header when a shift handover is
  finished; this is recorded in the Activity Log along with who did it.
- **History** — opens a small calendar. Days with a saved handover are
  marked (gold = draft, green = completed); click any day to open it.
  Past handovers are never overwritten — each date is its own record.
- **Print Handover** button, or **Ctrl+P** — prints just the handover
  sheet (no buttons, no navigation), formatted like the paper version.
- **Settings** (top bar) — edit the staff list, the AED denominations,
  and the Expected Petty Cash amount (default AED 2,500.00) without
  touching any code.
- **Activity Logs** (Settings → Activity Logs) — a read-only, global log
  of every meaningful saved change across all handovers: who made it,
  when, which handover date it belongs to, what changed, and the
  previous/new value where relevant. It's never shown on the main
  handover screen. It loads the latest 10 entries; **Show Older Logs**
  fetches the next 10 each click, so the whole log is never loaded at
  once. A log entry is written only when a debounced autosave actually
  reaches the server with a real change — never on every keystroke.

  If you already deployed this app before this feature was added, run
  the one-time migration to add the new columns to your existing
  `activity_logs` table:

  ```bash
  cd worker
  wrangler d1 execute villaggio-handover-db --file=./migrations/002_activity_logs_details.sql --remote
  ```

  Fresh installs don't need this — `schema.sql` already includes it.

## 6. Offline behaviour

If the connection drops mid-shift, the app keeps working: the current
handover is cached in the browser (IndexedDB) and edits are queued
locally. As soon as the connection returns, queued changes sync to D1
automatically. The status indicator turns amber ("Offline — saved
locally") so staff know a sync is pending.

## 7. Data model

| Table | Purpose |
|---|---|
| `handovers` | One row per date/shift: from/to staff, notes, credits, give backs, cash posting, status |
| `handover_items` | The numbered room/note/status rows |
| `cash_denominations` | AED denomination quantities for a handover |
| `foreign_currency` | Foreign currency rows (label, rate, quantity) for a handover |
| `activity_logs` | Created / Edited / Completed entries with staff name and timestamp |
| `settings` | Staff names, denomination list, expected petty cash — editable from Settings |

Each handover has its own UUID and its own set of rows in the four
related tables, so historical handovers are never overwritten — a new
date is simply a new record.

**Data isolation guarantee:** every save (`PUT /api/handover/:id`)
only ever touches rows scoped to that one `handover_id` — it deletes
and re-inserts only that record's own items, denominations, and
foreign currency rows, and updates only that one row in `handovers`.
No endpoint ever writes to more than one date's records in a single
request. Copying from a previous day (`POST /api/handover` with
`source: "previous"`) only *reads* the earlier record and inserts new
rows with new IDs under the new date — the source record is never
updated. If a handover already exists for a date, `POST /api/handover`
returns that existing record unchanged rather than creating a
duplicate.

## 8. Verified calculation example

The formulas were checked against the example in the brief:

| Field | Value |
|---|---|
| Cash in Hand | AED 1,301.00 |
| Credits | AED 1,560.00 |
| Total | AED 2,861.00 |
| Give Backs | AED 0.00 |
| Cash Posting | AED 0.00 |
| Petty Cash | AED 2,861.00 |
| Expected Petty Cash | AED 2,500.00 |
| Difference | AED 361.00 **EXCESS** |

This matches exactly.
