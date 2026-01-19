-- D1 Database Schema for FoodSnap

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

-- Index for faster queries
CREATE INDEX IF NOT EXISTS idx_meals_user_date ON meals(user_id, eaten_at);
CREATE INDEX IF NOT EXISTS idx_meals_eaten_at ON meals(eaten_at);
