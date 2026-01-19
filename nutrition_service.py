from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from database import Database


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _round1(x: float) -> float:
    return float(round(x, 1))


def _round0(x: float) -> float:
    return float(round(x))


def _iso_now_local() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


@dataclass
class MacroTargets:
    kcal: float
    protein_g: float
    carbs_g: float
    fat_g: float


class NutritionService:
    def __init__(self, db: Database):
        self.db = db

    # --------- Food mapping & nutrition ----------
    def map_food_name(self, name: str) -> Dict[str, Any]:
        """
        Returns:
          {
            "mapped": bool,
            "canonical_name": str,
            "per_100g": {...} | None
          }
        """
        hit = self.db.find_food_by_name(name)
        if hit:
            return {"mapped": True, "canonical_name": hit["canonical_name"], "per_100g": hit["per_100g"]}
        return {"mapped": False, "canonical_name": name.strip(), "per_100g": None}

    def compute_item_nutrition(self, per_100g: Dict[str, Any], weight_g: float) -> Dict[str, float]:
        factor = float(weight_g) / 100.0
        return {
            "kcal": _round0(float(per_100g.get("kcal", 0)) * factor),
            "protein_g": _round1(float(per_100g.get("protein_g", 0)) * factor),
            "carbs_g": _round1(float(per_100g.get("carbs_g", 0)) * factor),
            "fat_g": _round1(float(per_100g.get("fat_g", 0)) * factor),
            "fiber_g": _round1(float(per_100g.get("fiber_g", 0)) * factor),
            "sugar_g": _round1(float(per_100g.get("sugar_g", 0)) * factor),
            "sodium_mg": _round0(float(per_100g.get("sodium_mg", 0)) * factor),
        }

    def build_meal_from_ai(self, ai_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Convert AI foods -> items with nutrition.
        Priority:
        1. Use AI-provided nutrition_per_100g if available
        2. Fall back to database lookup
        3. If neither, mark missing_nutrition=true
        """
        items: List[Dict[str, Any]] = []
        totals = {"kcal": 0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0, "fiber_g": 0.0, "sugar_g": 0.0, "sodium_mg": 0}

        for f in ai_result.get("foods", []):
            raw_name = (f.get("name") or "").strip()
            if not raw_name:
                continue

            portion = f.get("portion") or {}
            est_g = float(portion.get("estimated") or 0)
            if est_g <= 0:
                # fallback: if min/max exist, take mid
                mn = float(portion.get("min") or 0)
                mx = float(portion.get("max") or 0)
                est_g = (mn + mx) / 2 if mx > 0 else 100  # default to 100g if no portion info

            # Priority 1: Use AI-provided nutrition
            ai_nutrition = f.get("nutrition_per_100g")
            if ai_nutrition and ai_nutrition.get("kcal"):
                per_100g = {
                    "kcal": float(ai_nutrition.get("kcal", 0)),
                    "protein_g": float(ai_nutrition.get("protein_g", 0)),
                    "carbs_g": float(ai_nutrition.get("carbs_g", 0)),
                    "fat_g": float(ai_nutrition.get("fat_g", 0)),
                    "fiber_g": float(ai_nutrition.get("fiber_g", 0)),
                    "sugar_g": float(ai_nutrition.get("sugar_g", 0)),
                    "sodium_mg": float(ai_nutrition.get("sodium_mg", 0)),
                }
                macros = self.compute_item_nutrition(per_100g, est_g)
                missing = False
            else:
                # Priority 2: Database lookup
                mapped = self.map_food_name(raw_name)
                per_100g = mapped["per_100g"]
                if per_100g:
                    macros = self.compute_item_nutrition(per_100g, est_g)
                    missing = False
                else:
                    # Priority 3: No nutrition data available
                    macros = {"kcal": 0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0, "fiber_g": 0.0, "sugar_g": 0.0, "sodium_mg": 0}
                    missing = True

            item = {
                "name": raw_name,
                "original_name": raw_name,
                "confidence": float(f.get("confidence") or 0),
                "weight_g": _round0(est_g),
                "portion": portion,
                "cooking_method": f.get("cooking_method"),
                "notes": f.get("notes"),
                "need_user_confirm": bool(f.get("need_user_confirm", False)) or missing,
                "missing_nutrition": missing,
                "nutrition": macros,
                "manually_corrected": False,
            }
            items.append(item)

            for k in totals.keys():
                totals[k] = totals[k] + macros.get(k, 0)  # type: ignore

        # normalize totals types
        totals["kcal"] = int(totals["kcal"])
        totals["sodium_mg"] = int(totals["sodium_mg"])
        totals["protein_g"] = _round1(float(totals["protein_g"]))
        totals["carbs_g"] = _round1(float(totals["carbs_g"]))
        totals["fat_g"] = _round1(float(totals["fat_g"]))
        totals["fiber_g"] = _round1(float(totals["fiber_g"]))
        totals["sugar_g"] = _round1(float(totals["sugar_g"]))

        return {"items": items, "totals": totals}

    # --------- Targets & recommendations ----------
    def compute_targets(self, goal_type: str, profile: Dict[str, Any]) -> Dict[str, Any]:
        """
        Simplified TDEE + macro split.
        profile: sex, age, height_cm, weight_kg, activity_level
        activity_level: sedentary|light|moderate|active|very_active
        """
        sex = (profile.get("sex") or "male").lower()
        age = float(profile.get("age") or 28)
        height = float(profile.get("height_cm") or 170)
        weight = float(profile.get("weight_kg") or 65)
        activity = (profile.get("activity_level") or "moderate").lower()

        # Mifflin-St Jeor BMR
        if sex in ("female", "f"):
            bmr = 10 * weight + 6.25 * height - 5 * age - 161
        else:
            bmr = 10 * weight + 6.25 * height - 5 * age + 5

        factors = {
            "sedentary": 1.2,
            "light": 1.375,
            "moderate": 1.55,
            "active": 1.725,
            "very_active": 1.9,
        }
        tdee = bmr * factors.get(activity, 1.55)

        goal = (goal_type or "health").lower()
        if goal == "cut" or goal == "fat_loss" or goal == "减脂":
            kcal = tdee - 400
            split = (0.30, 0.40, 0.30)  # P/C/F by calories
        elif goal == "bulk" or goal == "muscle_gain" or goal == "增肌":
            kcal = tdee + 250
            split = (0.30, 0.45, 0.25)
        else:
            kcal = tdee
            split = (0.25, 0.50, 0.25)

        kcal = _clamp(kcal, 1200, 4000)

        p_cal, c_cal, f_cal = kcal * split[0], kcal * split[1], kcal * split[2]
        targets = MacroTargets(
            kcal=_round0(kcal),
            protein_g=_round0(p_cal / 4),
            carbs_g=_round0(c_cal / 4),
            fat_g=_round0(f_cal / 9),
        )

        return {
            "kcal": targets.kcal,
            "protein_g": targets.protein_g,
            "carbs_g": targets.carbs_g,
            "fat_g": targets.fat_g,
            "generated_at": _iso_now_local(),
            "method": "mifflin_st_jeor_simplified",
        }

    def aggregate_totals(self, meals: List[Dict[str, Any]]) -> Dict[str, Any]:
        totals = {"kcal": 0, "protein_g": 0.0, "carbs_g": 0.0, "fat_g": 0.0, "fiber_g": 0.0, "sugar_g": 0.0, "sodium_mg": 0}
        for m in meals:
            t = m.get("totals") or {}
            totals["kcal"] += int(t.get("kcal") or 0)
            totals["protein_g"] += float(t.get("protein_g") or 0)
            totals["carbs_g"] += float(t.get("carbs_g") or 0)
            totals["fat_g"] += float(t.get("fat_g") or 0)
            totals["fiber_g"] += float(t.get("fiber_g") or 0)
            totals["sugar_g"] += float(t.get("sugar_g") or 0)
            totals["sodium_mg"] += int(t.get("sodium_mg") or 0)

        totals["protein_g"] = _round1(totals["protein_g"])
        totals["carbs_g"] = _round1(totals["carbs_g"])
        totals["fat_g"] = _round1(totals["fat_g"])
        totals["fiber_g"] = _round1(totals["fiber_g"])
        totals["sugar_g"] = _round1(totals["sugar_g"])
        return totals

    def recommend_next_meal(self, user_goal: Optional[Dict[str, Any]], today_totals: Dict[str, Any]) -> Dict[str, Any]:
        if not user_goal:
            return {
                "summary": "尚未设置目标。建议先在“我的/目标”中设置减脂/增肌/健康目标，以生成更准确的每日摄入建议。",
                "actions": [],
            }

        targets = user_goal["targets"]
        diff = {
            "kcal": float(targets.get("kcal", 0)) - float(today_totals.get("kcal", 0)),
            "protein_g": float(targets.get("protein_g", 0)) - float(today_totals.get("protein_g", 0)),
            "carbs_g": float(targets.get("carbs_g", 0)) - float(today_totals.get("carbs_g", 0)),
            "fat_g": float(targets.get("fat_g", 0)) - float(today_totals.get("fat_g", 0)),
        }

        actions: List[Dict[str, Any]] = []

        # Protein first
        if diff["protein_g"] > 15:
            need = _round0(diff["protein_g"])
            actions.append(
                {
                    "type": "increase_protein",
                    "title": f"下一餐补蛋白约 {need}g",
                    "examples": ["鸡胸肉150g", "豆腐300g", "无糖酸奶300g", "鸡蛋2个 + 牛奶250ml"],
                }
            )

        # If kcal over
        if diff["kcal"] < -150:
            actions.append(
                {
                    "type": "reduce_calories",
                    "title": "今日热量已偏高，下一餐建议清淡",
                    "examples": ["主食减半", "少油少酱", "用蒸/煮替代煎炸", "多蔬菜+优质蛋白"],
                }
            )
        else:
            # carbs/fat balancing
            if diff["carbs_g"] < -30:
                actions.append(
                    {
                        "type": "reduce_carbs",
                        "title": "碳水偏高：下一餐减少主食",
                        "examples": ["米饭/面条减半", "用蔬菜/菌菇增加饱腹", "选择低糖水果少量"],
                    }
                )
            if diff["fat_g"] < -15:
                actions.append(
                    {
                        "type": "reduce_fat",
                        "title": "脂肪偏高：下一餐减少油脂来源",
                        "examples": ["少油烹饪", "少坚果/奶油/油炸", "酱料分开蘸"],
                    }
                )

        # If still lacking kcal and macros
        if diff["kcal"] > 200 and diff["protein_g"] <= 15:
            actions.append(
                {
                    "type": "balanced_meal",
                    "title": "下一餐可正常均衡进食",
                    "examples": ["一份蛋白 + 一份主食 + 两份蔬菜", "注意控制油量"],
                }
            )

        summary = "根据你今日摄入与目标差值，给出下一餐可执行建议。"
        return {"summary": summary, "diff_to_target": {k: _round0(v) for k, v in diff.items()}, "actions": actions}