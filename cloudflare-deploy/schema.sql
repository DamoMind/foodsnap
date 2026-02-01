-- D1 Database Schema for FoodSnap

-- Users table for OAuth authentication
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE,
    name TEXT,
    avatar_url TEXT,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    legacy_user_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_login_at TEXT DEFAULT (datetime('now')),
    UNIQUE(provider, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_legacy ON users(legacy_user_id);

-- User goals table
CREATE TABLE IF NOT EXISTS user_goals (
    user_id TEXT PRIMARY KEY,
    goal_type TEXT NOT NULL,
    profile TEXT NOT NULL,  -- JSON
    targets TEXT NOT NULL,  -- JSON
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

-- Meals table
CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
    eaten_at TEXT NOT NULL,
    items TEXT NOT NULL,    -- JSON array
    totals TEXT NOT NULL,   -- JSON
    image_path TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, eaten_at);
CREATE INDEX IF NOT EXISTS idx_meals_eaten_at ON meals(eaten_at);

-- Daily activity/exercise table
CREATE TABLE IF NOT EXISTS daily_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    day_iso TEXT NOT NULL,
    exercise_kcal REAL DEFAULT 0,
    steps INTEGER DEFAULT 0,
    active_minutes INTEGER DEFAULT 0,
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, day_iso)
);
CREATE INDEX IF NOT EXISTS idx_activity_user_day ON daily_activity(user_id, day_iso);

-- Body metrics table (weight, body fat, etc.)
CREATE TABLE IF NOT EXISTS body_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    measured_at TEXT NOT NULL,
    weight_kg REAL,
    body_fat_pct REAL,
    muscle_mass_kg REAL,
    water_pct REAL,
    bmi REAL,
    notes TEXT,
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_body_metrics_user_date ON body_metrics(user_id, measured_at);

-- Supplements/Medications table
CREATE TABLE IF NOT EXISTS supplements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    dosage TEXT,
    frequency TEXT,
    time_of_day TEXT,
    notes TEXT,
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_supplements_user ON supplements(user_id, active);

-- Supplement intake log
CREATE TABLE IF NOT EXISTS supplement_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    supplement_id INTEGER NOT NULL,
    taken_at TEXT NOT NULL,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (supplement_id) REFERENCES supplements(id)
);
CREATE INDEX IF NOT EXISTS idx_supplement_logs_user_date ON supplement_logs(user_id, taken_at);

-- Async analyze tasks table
CREATE TABLE IF NOT EXISTS analyze_tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, processing, completed, failed
    image_data TEXT,              -- base64 (for small images) or R2 path
    lang TEXT DEFAULT 'zh',
    result TEXT,                  -- JSON result
    error TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_analyze_tasks_user ON analyze_tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_analyze_tasks_status ON analyze_tasks(status, created_at);
