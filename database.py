import json
import sqlite3
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple


def _utc_now_iso() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _today_local_iso() -> str:
    # MVP：用服务器本地日期作为“今日”
    return date.today().isoformat()


def _week_start_local(d: date) -> date:
    # Monday as start of week
    return d - timedelta(days=d.weekday())


@dataclass
class MealRow:
    id: int
    user_id: str
    meal_type: str
    eaten_at: str
    items_json: str
    totals_json: str
    image_path: Optional[str]
    created_at: str
    updated_at: str


class Database:
    def __init__(self, db_path: str = "app.db"):
        self.db_path = db_path
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS meals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    meal_type TEXT NOT NULL,
                    eaten_at TEXT NOT NULL,
                    items_json TEXT NOT NULL,
                    totals_json TEXT NOT NULL,
                    image_path TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_meals_user_eaten_at ON meals(user_id, eaten_at);"
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS user_goals (
                    user_id TEXT PRIMARY KEY,
                    goal_type TEXT NOT NULL,
                    profile_json TEXT NOT NULL,
                    targets_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS food_nutrition (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    canonical_name TEXT NOT NULL UNIQUE,
                    aliases_json TEXT NOT NULL,
                    per_100g_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_food_canonical_name ON food_nutrition(canonical_name);"
            )

            conn.commit()

        self._seed_foods_if_empty()

    def _seed_foods_if_empty(self) -> None:
        with self._connect() as conn:
            row = conn.execute("SELECT COUNT(1) AS c FROM food_nutrition;").fetchone()
            if int(row["c"]) > 0:
                return

            now = _utc_now_iso()

            # 简化营养库（每100g）：kcal, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg
            foods = [
                ("米饭", ["白米饭", "熟米饭", "米饭(熟)"], dict(kcal=116, protein_g=2.6, carbs_g=25.9, fat_g=0.3, fiber_g=0.4, sugar_g=0.1, sodium_mg=1)),
                ("鸡胸肉", ["鸡胸", "鸡胸肉(熟)", "烤鸡胸"], dict(kcal=165, protein_g=31.0, carbs_g=0.0, fat_g=3.6, fiber_g=0.0, sugar_g=0.0, sodium_mg=74)),
                ("鸡蛋", ["全蛋", "煮鸡蛋", "鸡蛋(熟)"], dict(kcal=155, protein_g=13.0, carbs_g=1.1, fat_g=11.0, fiber_g=0.0, sugar_g=1.1, sodium_mg=124)),
                ("西兰花", ["花椰菜", "西兰花(熟)"], dict(kcal=35, protein_g=2.4, carbs_g=7.2, fat_g=0.4, fiber_g=3.3, sugar_g=1.4, sodium_mg=41)),
                ("青菜", ["小白菜", "油菜", "绿叶菜"], dict(kcal=20, protein_g=1.5, carbs_g=3.0, fat_g=0.2, fiber_g=1.5, sugar_g=1.0, sodium_mg=30)),
                ("牛奶", ["纯牛奶", "全脂牛奶"], dict(kcal=61, protein_g=3.2, carbs_g=4.8, fat_g=3.3, fiber_g=0.0, sugar_g=4.8, sodium_mg=43)),
                ("酸奶", ["原味酸奶", "无糖酸奶"], dict(kcal=63, protein_g=3.5, carbs_g=4.7, fat_g=3.3, fiber_g=0.0, sugar_g=4.7, sodium_mg=50)),
                ("豆腐", ["北豆腐", "嫩豆腐"], dict(kcal=76, protein_g=8.1, carbs_g=1.9, fat_g=4.8, fiber_g=0.3, sugar_g=0.3, sodium_mg=7)),
                ("香蕉", ["香蕉(生)"], dict(kcal=89, protein_g=1.1, carbs_g=22.8, fat_g=0.3, fiber_g=2.6, sugar_g=12.2, sodium_mg=1)),
                ("苹果", ["苹果(生)"], dict(kcal=52, protein_g=0.3, carbs_g=13.8, fat_g=0.2, fiber_g=2.4, sugar_g=10.4, sodium_mg=1)),
            ]

            for canonical, aliases, per100 in foods:
                conn.execute(
                    """
                    INSERT INTO food_nutrition(canonical_name, aliases_json, per_100g_json, updated_at)
                    VALUES(?, ?, ?, ?)
                    """,
                    (canonical, json.dumps(aliases, ensure_ascii=False), json.dumps(per100, ensure_ascii=False), now),
                )
            conn.commit()

    # ---------- Goals ----------
    def upsert_user_goal(self, user_id: str, goal_type: str, profile: Dict[str, Any], targets: Dict[str, Any]) -> Dict[str, Any]:
        now = _utc_now_iso()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO user_goals(user_id, goal_type, profile_json, targets_json, updated_at)
                VALUES(?, ?, ?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET
                    goal_type=excluded.goal_type,
                    profile_json=excluded.profile_json,
                    targets_json=excluded.targets_json,
                    updated_at=excluded.updated_at
                """,
                (user_id, goal_type, json.dumps(profile, ensure_ascii=False), json.dumps(targets, ensure_ascii=False), now),
            )
            conn.commit()
        return self.get_user_goal(user_id) or {}

    def get_user_goal(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM user_goals WHERE user_id=?;", (user_id,)).fetchone()
            if not row:
                return None
            return {
                "user_id": row["user_id"],
                "goal_type": row["goal_type"],
                "profile": json.loads(row["profile_json"]),
                "targets": json.loads(row["targets_json"]),
                "updated_at": row["updated_at"],
            }

    # ---------- Meals ----------
    def create_meal(
        self,
        user_id: str,
        meal_type: str,
        eaten_at: str,
        items: List[Dict[str, Any]],
        totals: Dict[str, Any],
        image_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        now = _utc_now_iso()
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO meals(user_id, meal_type, eaten_at, items_json, totals_json, image_path, created_at, updated_at)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    user_id,
                    meal_type,
                    eaten_at,
                    json.dumps(items, ensure_ascii=False),
                    json.dumps(totals, ensure_ascii=False),
                    image_path,
                    now,
                    now,
                ),
            )
            conn.commit()
            meal_id = int(cur.lastrowid)
        return self.get_meal(meal_id)

    def get_meal(self, meal_id: int) -> Dict[str, Any]:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM meals WHERE id=?;", (meal_id,)).fetchone()
            if not row:
                raise KeyError("meal not found")
            return self._row_to_meal(row)

    def list_meals_by_date(self, user_id: str, day_iso: Optional[str] = None) -> List[Dict[str, Any]]:
        day_iso = day_iso or _today_local_iso()
        start = f"{day_iso}T00:00:00"
        end = f"{day_iso}T23:59:59"
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM meals
                WHERE user_id=? AND eaten_at BETWEEN ? AND ?
                ORDER BY eaten_at ASC, id ASC
                """,
                (user_id, start, end),
            ).fetchall()
            return [self._row_to_meal(r) for r in rows]

    def list_meals_in_range(self, user_id: str, start_iso: str, end_iso: str) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM meals
                WHERE user_id=? AND eaten_at BETWEEN ? AND ?
                ORDER BY eaten_at ASC, id ASC
                """,
                (user_id, start_iso, end_iso),
            ).fetchall()
            return [self._row_to_meal(r) for r in rows]

    def _row_to_meal(self, row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": int(row["id"]),
            "user_id": row["user_id"],
            "meal_type": row["meal_type"],
            "eaten_at": row["eaten_at"],
            "items": json.loads(row["items_json"]),
            "totals": json.loads(row["totals_json"]),
            "image_path": row["image_path"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # ---------- Nutrition DB ----------
    def find_food_by_name(self, name: str) -> Optional[Dict[str, Any]]:
        """
        简化匹配：先 canonical 精确，再 aliases 包含匹配（JSON LIKE）。
        """
        name = (name or "").strip()
        if not name:
            return None
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM food_nutrition WHERE canonical_name=?;",
                (name,),
            ).fetchone()
            if row:
                return self._row_to_food(row)

            # aliases_json contains name
            row = conn.execute(
                "SELECT * FROM food_nutrition WHERE aliases_json LIKE ? LIMIT 1;",
                (f"%{name}%",),
            ).fetchone()
            if row:
                return self._row_to_food(row)
        return None

    def _row_to_food(self, row: sqlite3.Row) -> Dict[str, Any]:
        return {
            "id": int(row["id"]),
            "canonical_name": row["canonical_name"],
            "aliases": json.loads(row["aliases_json"]),
            "per_100g": json.loads(row["per_100g_json"]),
            "updated_at": row["updated_at"],
        }

    # ---------- Stats helpers ----------
    def get_today_range(self) -> Tuple[str, str]:
        d = date.today()
        return f"{d.isoformat()}T00:00:00", f"{d.isoformat()}T23:59:59"

    def get_week_range(self) -> Tuple[str, str]:
        d = date.today()
        ws = _week_start_local(d)
        we = ws + timedelta(days=6)
        return f"{ws.isoformat()}T00:00:00", f"{we.isoformat()}T23:59:59"