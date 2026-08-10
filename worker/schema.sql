-- Grand Villaggio Hotel — Reception Handover System
-- D1 Database Schema

CREATE TABLE IF NOT EXISTS handovers (
  id TEXT PRIMARY KEY,
  reference_date TEXT NOT NULL,        -- YYYY-MM-DD
  from_staff TEXT DEFAULT '',
  to_staff TEXT DEFAULT '',
  general_notes TEXT DEFAULT '',
  credits REAL DEFAULT 0,
  give_backs REAL DEFAULT 0,
  cash_posting REAL DEFAULT 0,
  status TEXT DEFAULT 'draft',         -- draft | completed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handovers_date ON handovers(reference_date);

CREATE TABLE IF NOT EXISTS handover_items (
  id TEXT PRIMARY KEY,
  handover_id TEXT NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  room TEXT DEFAULT '',
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'Pending'
);

CREATE INDEX IF NOT EXISTS idx_items_handover ON handover_items(handover_id);

CREATE TABLE IF NOT EXISTS cash_denominations (
  id TEXT PRIMARY KEY,
  handover_id TEXT NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
  denomination REAL NOT NULL,
  qty INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_denom_handover ON cash_denominations(handover_id);

CREATE TABLE IF NOT EXISTS foreign_currency (
  id TEXT PRIMARY KEY,
  handover_id TEXT NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                 -- e.g. "USD 3.67"
  rate REAL DEFAULT 0,
  qty REAL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_fx_handover ON foreign_currency(handover_id);

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  handover_id TEXT NOT NULL REFERENCES handovers(id) ON DELETE CASCADE,
  action TEXT NOT NULL,                -- Created | Edited | Completed
  staff_name TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_handover ON activity_logs(handover_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                  -- JSON encoded
);

-- Seed default settings
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('staff_names', '["KAMRAN","KISHAN","CARYL","KATHY","MAGDY","AUBREY"]'),
  ('expected_petty_cash', '2500'),
  ('denominations', '[1000,500,200,100,50,20,10,5,1,0.5,0.25]');
