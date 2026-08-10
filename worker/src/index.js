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

async function createHandover(db, body) {
  const settings = await getSettings(db);
  const id = uid();
  const ts = now();
  const referenceDate = body.reference_date;
  if (!referenceDate) throw new Error("reference_date is required");

  await db
    .prepare(
      `INSERT INTO handovers (id, reference_date, from_staff, to_staff, general_notes, credits, give_backs, cash_posting, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 0, 0, 0, 'draft', ?, ?)`
    )
    .bind(id, referenceDate, body.from_staff || "", body.to_staff || "", ts, ts)
    .run();

  // Seed denomination rows from current settings so the sheet is ready to fill in.
  const denoms = settings.denominations || [1000, 500, 200, 100, 50, 20, 10, 5, 1, 0.5, 0.25];
  const stmts = denoms.map((d) =>
    db
      .prepare("INSERT INTO cash_denominations (id, handover_id, denomination, qty) VALUES (?, ?, ?, 0)")
      .bind(uid(), id, d)
  );
  stmts.push(
    db
      .prepare("INSERT INTO activity_logs (id, handover_id, action, staff_name, created_at) VALUES (?, ?, 'Created', ?, ?)")
      .bind(uid(), id, body.staff_name || body.from_staff || "", ts)
  );
  await db.batch(stmts);

  return fetchFullHandover(db, id);
}

async function saveHandover(db, id, body) {
  const existing = await db.prepare("SELECT id, status FROM handovers WHERE id = ?").bind(id).first();
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

  const action = !wasCompleted && nowCompleted ? "Completed" : "Edited";
  stmts.push(
    db
      .prepare("INSERT INTO activity_logs (id, handover_id, action, staff_name  , created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(uid(), id, action, body.from_staff   || "", ts)
  );

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
