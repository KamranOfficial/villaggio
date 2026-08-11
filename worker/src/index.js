// Grand Villaggio Hotel — Reception Handover System
// Cloudflare Worker API (backed by D1)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function uid() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function fmtMoney(v) {
  const n = Number(v) || 0;
  return "AED " + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- Activity log diffing ----------
//
// Builds a list of meaningful, human-readable changes between the
// previously-saved handover and the incoming save. Only actual value
// changes produce an entry — an autosave that doesn't change a field
// (e.g. triggered by an unrelated edit) produces no log for that field.
function diffHandover(before, body) {
  const logs = [];

  const textField = (key, label) => {
    const prev = before[key] || "";
    const next = body[key] !== undefined ? body[key] || "" : prev;
    if (prev !== next) {
      logs.push({ action: `${label} changed`, previous_value: prev || "(empty)", new_value: next || "(empty)" });
    }
  };
  textField("from_staff", "From Staff");
  textField("to_staff", "To Staff");

  const prevNotes = before.general_notes || "";
  const nextNotes = body.general_notes !== undefined ? body.general_notes || "" : prevNotes;
  if (prevNotes !== nextNotes) {
    logs.push({ action: "Handover Notes changed", previous_value: null, new_value: null });
  }

  const moneyField = (key, label) => {
    const prev = num(before[key]);
    const next = num(body[key], prev);
    if (Math.round(prev * 100) !== Math.round(next * 100)) {
      logs.push({ action: `${label} changed`, previous_value: fmtMoney(prev), new_value: fmtMoney(next) });
    }
  };
  moneyField("credits", "Credits");
  moneyField("give_backs", "Give Backs");
  moneyField("cash_posting", "Cash Posting");

  // Handover items — matched by id so we can tell an edit apart from an
  // add or a remove. Items without an id (brand new rows) are always
  // "added".
  const beforeItems = before.items || [];
  const nextItems = body.items || [];
  const beforeById = new Map(beforeItems.filter((it) => it.id).map((it) => [it.id, it]));
  const matchedIds = new Set();

  nextItems.forEach((it) => {
    if (it.id && beforeById.has(it.id)) {
      matchedIds.add(it.id);
      const prevIt = beforeById.get(it.id);
      const label = it.room || prevIt.room || "";
      const roomLabel = label ? `Room ${label}` : "Handover row";
      if ((prevIt.room || "") !== (it.room || "")) {
        logs.push({
          action: "Room number changed",
          previous_value: prevIt.room || "(empty)",
          new_value: it.room || "(empty)",
        });
      }
      if ((prevIt.status || "Pending") !== (it.status || "Pending")) {
        logs.push({
          action: `${roomLabel} status changed`,
          previous_value: prevIt.status || "Pending",
          new_value: it.status || "Pending",
        });
      }
      if ((prevIt.note || "") !== (it.note || "")) {
        logs.push({ action: `${roomLabel} note changed`, previous_value: null, new_value: null });
      }
    } else {
      const roomLabel = it.room ? `Room ${it.room}` : "Handover row";
      logs.push({ action: `${roomLabel} added`, previous_value: null, new_value: null });
    }
  });

  beforeItems.forEach((it) => {
    if (it.id && !matchedIds.has(it.id)) {
      const roomLabel = it.room ? `Room ${it.room}` : "Handover row";
      logs.push({ action: `${roomLabel} removed`, previous_value: null, new_value: null });
    }
  });

  // Cash denomination + foreign currency counts are summarized into a
  // single "Cash Count changed" line (rather than one log per
  // denomination row) to keep the log readable.
  const cashTotal = (list, isFx) =>
    (list || []).reduce((sum, row) => {
      if (isFx) return sum + Math.max(0, num(row.rate)) * Math.max(0, num(row.qty));
      return sum + num(row.denomination) * Math.max(0, Math.round(num(row.qty)));
    }, 0);

  const prevCash = cashTotal(before.denominations, false) + cashTotal(before.foreign_currency, true);
  const nextCash = cashTotal(body.denominations, false) + cashTotal(body.foreign_currency, true);
  if (Math.round(prevCash * 100) !== Math.round(nextCash * 100)) {
    logs.push({ action: "Cash Count changed", previous_value: fmtMoney(prevCash), new_value: fmtMoney(nextCash) });
  }

  return logs;
}

function insertActivityLog(stmts, db, { handoverId, handoverDate, staffName, action, previousValue, newValue, ts }) {
  stmts.push(
    db
      .prepare(
        `INSERT INTO activity_logs (id, handover_id, handover_date, staff_name, action, previous_value, new_value, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(uid(), handoverId, handoverDate, staffName || "", action, previousValue ?? null, newValue ?? null, ts)
  );
}

// ---------- Settings ----------

async function getSettings(db) {
  const rows = await db.prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const row of rows.results) {
    out[row.key] = JSON.parse(row.value);
  }
  return out;
}

async function putSettings(db, body) {
  const allowed = ["staff_names", "expected_petty_cash", "denominations"];
  const stmts = [];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      stmts.push(
        db.prepare(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).bind(key, JSON.stringify(body[key]))
      );
    }
  }
  if (stmts.length) await db.batch(stmts);
  return getSettings(db);
}

// ---------- Handover assembly ----------

async function fetchFullHandover(db, id) {
  const handover = await db
    .prepare("SELECT * FROM handovers WHERE id = ?")
    .bind(id)
    .first();
  if (!handover) return null;

  const [items, denominations, foreignCurrency, activity] = await Promise.all([
    db
      .prepare("SELECT * FROM handover_items WHERE handover_id = ? ORDER BY position ASC")
      .bind(id)
      .all(),
    db
      .prepare("SELECT * FROM cash_denominations WHERE handover_id = ? ORDER BY denomination DESC")
      .bind(id)
      .all(),
    db
      .prepare("SELECT * FROM foreign_currency WHERE handover_id = ? ORDER BY rowid ASC")
      .bind(id)
      .all(),
    db
      .prepare("SELECT * FROM activity_logs WHERE handover_id = ? ORDER BY created_at DESC")
      .bind(id)
      .all(),
  ]);

  return {
    ...handover,
    items: items.results,
    denominations: denominations.results,
    foreign_currency: foreignCurrency.results,
    activity: activity.results,
  };
}

async function findPreviousHandover(db, beforeDate) {
  const row = await db
    .prepare(
      "SELECT id FROM handovers WHERE reference_date < ? ORDER BY reference_date DESC, created_at DESC LIMIT 1"
    )
    .bind(beforeDate)
    .first();
  if (!row) return null;
  return fetchFullHandover(db, row.id);
}

async function createHandover(db, body) {
  const id = uid();
  const ts = now();
  const referenceDate = body.reference_date;
  if (!referenceDate) throw new Error("reference_date is required");

  // Guard: never silently duplicate a date. If a handover already exists
  // for this exact date, hand back the existing record untouched instead
  // of creating a second one.
  const already = await db
    .prepare("SELECT id FROM handovers WHERE reference_date = ? ORDER BY created_at DESC LIMIT 1")
    .bind(referenceDate)
    .first();
  if (already) return fetchFullHandover(db, already.id);

  const source = body.source === "previous" ? "previous" : "blank";
  let sourceHandover = null;
  if (source === "previous") {
    // Read-only lookup — the earlier record is never written to.
    sourceHandover = await findPreviousHandover(db, referenceDate);
  }

  await db
    .prepare(
      `INSERT INTO handovers (id, reference_date, from_staff, to_staff, general_notes, credits, give_backs, cash_posting, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 0, 0, 0, 'draft', ?, ?)`
    )
    .bind(id, referenceDate, body.from_staff || "", body.to_staff || "", ts, ts)
    .run();

  const stmts = [];

  if (sourceHandover) {
    // Carry forward the physical cash count and any still-open room
    // items from the previous shift. Every row gets a brand-new id and
    // is linked only to the new handover_id — nothing here references
    // or mutates the source record.
    (sourceHandover.items || [])
      .filter((it) => (it.status || "Pending") !== "Done")
      .forEach((item, idx) => {
        stmts.push(
          db
            .prepare(
              "INSERT INTO handover_items (id, handover_id, position, room, note, status) VALUES (?, ?, ?, ?, ?, ?)"
            )
            .bind(uid(), id, idx + 1, item.room || "", item.note || "", item.status || "Pending")
        );
      });
    (sourceHandover.denominations || []).forEach((d) => {
      stmts.push(
        db
          .prepare("INSERT INTO cash_denominations (id, handover_id, denomination, qty) VALUES (?, ?, ?, ?)")
          .bind(uid(), id, d.denomination, d.qty || 0)
      );
    });
    (sourceHandover.foreign_currency || []).forEach((f) => {
      stmts.push(
        db
          .prepare("INSERT INTO foreign_currency (id, handover_id, label, rate, qty) VALUES (?, ?, ?, ?, ?)")
          .bind(uid(), id, f.label || "", f.rate || 0, f.qty || 0)
      );
    });
  } else {
    const settings = await getSettings(db);
    const denoms = settings.denominations || [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.5, 0.25];
    denoms.forEach((d) => {
      stmts.push(
        db
          .prepare("INSERT INTO cash_denominations (id, handover_id, denomination, qty) VALUES (?, ?, ?, 0)")
          .bind(uid(), id, d)
      );
    });
  }

  const activityAction = sourceHandover
    ? `Handover created — copied from ${sourceHandover.reference_date}`
    : "Handover created";
  insertActivityLog(stmts, db, {
    handoverId: id,
    handoverDate: referenceDate,
    staffName: body.staff_name || body.from_staff || "",
    action: activityAction,
    previousValue: null,
    newValue: null,
    ts,
  });

  if (stmts.length) await db.batch(stmts);
  return fetchFullHandover(db, id);
}

async function saveHandover(db, id, body) {
  // Fetch the full previous state (not just status) so we can diff it
  // against the incoming save and log exactly what changed.
  const existing = await fetchFullHandover(db, id);
  if (!existing) return null;

  const ts = now();
  const wasCompleted = existing.status === "completed";
  const nowCompleted = body.status === "completed";

  const stmts = [];

  stmts.push(
    db
      .prepare(
        `UPDATE handovers SET from_staff = ?, to_staff = ?, general_notes = ?, credits = ?, give_backs = ?, cash_posting = ?, status = ?, updated_at = ? WHERE id = ?`
      )
      .bind(
        body.from_staff || "",
        body.to_staff || "",
        body.general_notes || "",
        num(body.credits),
        num(body.give_backs),
        num(body.cash_posting),
        nowCompleted ? "completed" : "draft",
        ts,
        id
      )
  );

  // Replace items
  stmts.push(db.prepare("DELETE FROM handover_items WHERE handover_id = ?").bind(id));
  (body.items || []).forEach((item, idx) => {
    stmts.push(
      db
        .prepare(
          "INSERT INTO handover_items (id, handover_id, position, room, note, status) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(item.id || uid(), id, idx + 1, item.room || "", item.note || "", item.status || "Pending")
    );
  });

  // Replace denominations
  stmts.push(db.prepare("DELETE FROM cash_denominations WHERE handover_id = ?").bind(id));
  (body.denominations || []).forEach((d) => {
    stmts.push(
      db
        .prepare("INSERT INTO cash_denominations (id, handover_id, denomination, qty) VALUES (?, ?, ?, ?)")
        .bind(d.id || uid(), id, num(d.denomination), Math.max(0, Math.round(num(d.qty))))
    );
  });

  // Replace foreign currency
  stmts.push(db.prepare("DELETE FROM foreign_currency WHERE handover_id = ?").bind(id));
  (body.foreign_currency || []).forEach((f) => {
    stmts.push(
      db
        .prepare("INSERT INTO foreign_currency (id, handover_id, label, rate, qty) VALUES (?, ?, ?, ?, ?)")
        .bind(f.id || uid(), id, f.label || "", Math.max(0, num(f.rate)), Math.max(0, num(f.qty)))
    );
  });

  const staffName = body.to_staff || body.from_staff || existing.to_staff || existing.from_staff || "";

  // One log entry per meaningful field that actually changed — never one
  // generic "Edited" entry, and never one entry per keystroke (this runs
  // only when a debounced autosave actually reaches the server).
  const changeLogs = diffHandover(existing, body);

  if (!wasCompleted && nowCompleted) {
    changeLogs.push({ action: "Handover marked Completed", previous_value: null, new_value: null });
  } else if (wasCompleted && !nowCompleted) {
    changeLogs.push({ action: "Handover reopened as Draft", previous_value: null, new_value: null });
  }

  changeLogs.forEach((log) => {
    insertActivityLog(stmts, db, {
      handoverId: id,
      handoverDate: existing.reference_date,
      staffName,
      action: log.action,
      previousValue: log.previous_value,
      newValue: log.new_value,
      ts,
    });
  });

  await db.batch(stmts);
  return fetchFullHandover(db, id);
}

// ---------- Router ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = env.DB;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Anything outside /api is a static asset (the reception UI itself),
    // served straight from the bundled public/ directory.
    if (!path.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      // /api/settings
      if (path === "/api/settings" && request.method === "GET") {
        return json(await getSettings(db));
      }
      if (path === "/api/settings" && request.method === "PUT") {
        const body = await request.json();
        return json(await putSettings(db, body));
      }

      // /api/activity-logs?limit=10&offset=0
      // Global, read-only, paginated activity log across ALL handovers.
      // Only ever returns a page at a time — never the whole table — so
      // "Show Older Logs" can page through history without loading it
      // all at once. This is the only way activity logs are surfaced;
      // there is no separate per-handover log surfaced in the UI.
      if (path === "/api/activity-logs" && request.method === "GET") {
        const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10)));
        const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10));
        const rows = await db
          .prepare("SELECT * FROM activity_logs ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?")
          .bind(limit, offset)
          .all();
        return json(rows.results);
      }

      // /api/handover-dates  (calendar markers)
      if (path === "/api/handover-dates" && request.method === "GET") {
        const rows = await db
          .prepare("SELECT id, reference_date, status FROM handovers ORDER BY reference_date DESC")
          .all();
        return json(rows.results);
      }

      // /api/handover?date=YYYY-MM-DD
      if (path === "/api/handover" && request.method === "GET") {
        const date = url.searchParams.get("date");
        if (!date) return json({ error: "date query param required" }, 400);
        const row = await db
          .prepare("SELECT id FROM handovers WHERE reference_date = ? ORDER BY created_at DESC LIMIT 1")
          .bind(date)
          .first();
        if (!row) return json(null);
        return json(await fetchFullHandover(db, row.id));
      }

      // /api/handover/previous?before=YYYY-MM-DD (read-only lookup, never mutates)
      if (path === "/api/handover/previous" && request.method === "GET") {
        const before = url.searchParams.get("before");
        if (!before) return json({ error: "before query param required" }, 400);
        const prev = await findPreviousHandover(db, before);
        return json(prev);
      }

      if (path === "/api/handover" && request.method === "POST") {
        const body = await request.json();
        const handover = await createHandover(db, body);
        return json(handover, 201);
      }

      // /api/handover/:id
      const handoverMatch = path.match(/^\/api\/handover\/([a-zA-Z0-9-]+)$/);
      if (handoverMatch && request.method === "GET") {
        const handover = await fetchFullHandover(db, handoverMatch[1]);
        if (!handover) return json({ error: "not found" }, 404);
        return json(handover);
      }
      if (handoverMatch && request.method === "PUT") {
        const body = await request.json();
        const handover = await saveHandover(db, handoverMatch[1], body);
        if (!handover) return json({ error: "not found" }, 404);
        return json(handover);
      }

      // /api/handover/:id/activity
      const activityMatch = path.match(/^\/api\/handover\/([a-zA-Z0-9-]+)\/activity$/);
      if (activityMatch && request.method === "GET") {
        const rows = await db
          .prepare("SELECT * FROM activity_logs WHERE handover_id = ? ORDER BY created_at DESC")
          .bind(activityMatch[1])
          .all();
        return json(rows.results);
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: err.message || "server error" }, 500);
    }
  },
};
