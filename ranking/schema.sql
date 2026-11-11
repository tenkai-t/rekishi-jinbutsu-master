CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  count INTEGER NOT NULL,
  course TEXT NOT NULL,
  mode TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_board ON scores (mode, course, created_at);
CREATE INDEX IF NOT EXISTS idx_scores_uuid ON scores (uuid);
