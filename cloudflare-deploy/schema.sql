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
