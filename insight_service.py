"""
InsightFlow Integration Service

Provides advanced trend analysis and AI-powered insights for nutrition data.
Uses InsightFlow for time-series analysis when available, falls back to basic analysis.
"""

import asyncio
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional
import json

# Try to import InsightFlow (included in project)
try:
    from insightflow import InsightFlowClient, InsightFlowConfig, LLMProvider, AzureConfig, Event, EventType
    INSIGHTFLOW_AVAILABLE = True
    print("InsightFlow module loaded successfully")
except ImportError as e:
    INSIGHTFLOW_AVAILABLE = False
    print(f"InsightFlow import failed: {e}")


class InsightService:
    """
    Service for generating nutrition insights and trend analysis.

    Uses InsightFlow for advanced analysis when available,
    otherwise falls back to basic statistical analysis.
    """

    def __init__(
        self,
        db_path: str = "insights.db",
        azure_endpoint: Optional[str] = None,
        azure_api_key: Optional[str] = None,
        azure_deployment: str = "gpt-4o"
    ):
        self.db_path = db_path
        self.azure_endpoint = azure_endpoint
        self.azure_api_key = azure_api_key
        self.azure_deployment = azure_deployment
        self._client: Optional[Any] = None
        self._started = False

    async def start(self) -> bool:
        """Initialize the insight service."""
        if self._started:
            return True

        if not INSIGHTFLOW_AVAILABLE:
            print("InsightFlow not available, using basic analysis")
            self._started = True
            return True

        try:
            config = InsightFlowConfig(
                db_path=self.db_path,
                llm_provider=LLMProvider.AZURE if self.azure_api_key else LLMProvider.LOCAL,
            )

            if self.azure_api_key and self.azure_endpoint:
                config.azure_config = AzureConfig(
                    endpoint=self.azure_endpoint,
                    api_key=self.azure_api_key,
                    deployment=self.azure_deployment
                )

            self._client = InsightFlowClient(config)
            await self._client.start()
            self._started = True
            print("InsightFlow initialized successfully")
            return True
        except Exception as e:
            print(f"Failed to initialize InsightFlow: {e}")
            self._started = True  # Still mark as started for fallback
            return True

    async def stop(self) -> None:
        """Cleanup resources."""
        if self._client:
            await self._client.stop()
            self._client = None
        self._started = False

    async def log_meal(
        self,
        user_id: str,
        meal_type: str,
        totals: Dict[str, Any],
        items: List[Dict[str, Any]]
    ) -> Optional[str]:
        """
        Log a meal event for trend analysis.

        Args:
            user_id: User identifier
            meal_type: breakfast/lunch/dinner/snack
            totals: Nutrition totals
            items: Food items

        Returns:
            Event ID if logged successfully
        """
        if not self._client:
            return None

        try:
            # Log as sensor reading for nutrition values
            await self._client.log_sensor(
                value=float(totals.get("kcal", 0)),
                source=f"nutrition_{user_id}",
                tags=["meal", meal_type, "calories"],
                data={
                    "user_id": user_id,
                    "meal_type": meal_type,
                    "totals": totals,
                    "item_count": len(items)
                }
            )

            # Log individual macros
            for macro in ["protein_g", "carbs_g", "fat_g"]:
                if totals.get(macro):
                    await self._client.log_sensor(
                        value=float(totals.get(macro, 0)),
                        source=f"nutrition_{user_id}",
                        tags=["meal", meal_type, macro.replace("_g", "")]
                    )

            return "logged"
        except Exception as e:
            print(f"Failed to log meal to InsightFlow: {e}")
            return None

    async def get_weekly_insight(
        self,
        user_id: str,
        meals: List[Dict[str, Any]],
        goal: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Generate weekly nutrition insights.

        Args:
            user_id: User identifier
            meals: List of meals for the week
            goal: User's nutrition goal

        Returns:
            Insight dict with summary, patterns, and recommendations
        """
        # Calculate basic statistics
        daily_totals = self._aggregate_by_day(meals)
        patterns = self._detect_patterns(daily_totals, goal)

        # Try to get AI-powered insight if InsightFlow is available
        if self._client and meals:
            try:
                insight = await self._client.get_insight(
                    time_window="7d",
                    sources=[f"nutrition_{user_id}"],
                    topic="营养摄入趋势分析 / Nutrition intake trend analysis"
                )

                return {
                    "summary": insight.summary,
                    "patterns": patterns,
                    "recommendations": insight.recommendations if hasattr(insight, 'recommendations') else [],
                    "confidence": insight.confidence,
                    "ai_powered": True
                }
            except Exception as e:
                print(f"InsightFlow insight generation failed: {e}")

        # Fallback to basic analysis
        return self._generate_basic_insight(daily_totals, patterns, goal)

    def _aggregate_by_day(self, meals: List[Dict[str, Any]]) -> Dict[str, Dict[str, float]]:
        """Aggregate meals by day."""
        daily: Dict[str, Dict[str, float]] = {}

        for meal in meals:
            eaten_at = meal.get("eaten_at", "")
            if not eaten_at:
                continue

            day = eaten_at[:10]  # YYYY-MM-DD
            if day not in daily:
                daily[day] = {"kcal": 0, "protein_g": 0, "carbs_g": 0, "fat_g": 0, "meal_count": 0}

            totals = meal.get("totals", {})
            daily[day]["kcal"] += float(totals.get("kcal", 0))
            daily[day]["protein_g"] += float(totals.get("protein_g", 0))
            daily[day]["carbs_g"] += float(totals.get("carbs_g", 0))
            daily[day]["fat_g"] += float(totals.get("fat_g", 0))
            daily[day]["meal_count"] += 1

        return daily

    def _detect_patterns(
        self,
        daily_totals: Dict[str, Dict[str, float]],
        goal: Optional[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Detect nutrition patterns from daily data."""
        patterns = []

        if len(daily_totals) < 2:
            return patterns

        days = sorted(daily_totals.keys())
        kcal_values = [daily_totals[d]["kcal"] for d in days]
        protein_values = [daily_totals[d]["protein_g"] for d in days]

        # Calculate averages
        avg_kcal = sum(kcal_values) / len(kcal_values) if kcal_values else 0
        avg_protein = sum(protein_values) / len(protein_values) if protein_values else 0

        # Detect calorie trend
        if len(kcal_values) >= 3:
            trend = self._calculate_trend(kcal_values)
            if trend > 0.1:
                patterns.append({
                    "type": "trend_up",
                    "metric": "calories",
                    "description": "热量摄入呈上升趋势 / Calorie intake trending up",
                    "confidence": min(trend, 1.0)
                })
            elif trend < -0.1:
                patterns.append({
                    "type": "trend_down",
                    "metric": "calories",
                    "description": "热量摄入呈下降趋势 / Calorie intake trending down",
                    "confidence": min(abs(trend), 1.0)
                })

        # Compare to goals
        if goal and goal.get("targets"):
            targets = goal["targets"]

            if targets.get("kcal") and avg_kcal:
                ratio = avg_kcal / float(targets["kcal"])
                if ratio > 1.1:
                    patterns.append({
                        "type": "over_target",
                        "metric": "calories",
                        "description": f"平均热量超过目标 {(ratio-1)*100:.0f}% / Avg calories {(ratio-1)*100:.0f}% over target",
                        "confidence": 0.9
                    })
                elif ratio < 0.8:
                    patterns.append({
                        "type": "under_target",
                        "metric": "calories",
                        "description": f"平均热量低于目标 {(1-ratio)*100:.0f}% / Avg calories {(1-ratio)*100:.0f}% under target",
                        "confidence": 0.9
                    })

            if targets.get("protein_g") and avg_protein:
                ratio = avg_protein / float(targets["protein_g"])
                if ratio < 0.8:
                    patterns.append({
                        "type": "low_protein",
                        "metric": "protein",
                        "description": f"蛋白质摄入不足 / Protein intake insufficient ({avg_protein:.0f}g avg vs {targets['protein_g']:.0f}g target)",
                        "confidence": 0.85
                    })

        # Detect irregular eating
        meal_counts = [daily_totals[d]["meal_count"] for d in days]
        if meal_counts:
            avg_meals = sum(meal_counts) / len(meal_counts)
            variance = sum((m - avg_meals) ** 2 for m in meal_counts) / len(meal_counts)
            if variance > 1:
                patterns.append({
                    "type": "irregular",
                    "metric": "meal_frequency",
                    "description": "进餐频率不规律 / Irregular meal frequency",
                    "confidence": min(variance / 2, 1.0)
                })

        return patterns

    def _calculate_trend(self, values: List[float]) -> float:
        """Calculate trend using linear regression."""
        if len(values) < 2:
            return 0.0

        n = len(values)
        x_mean = (n - 1) / 2
        y_mean = sum(values) / n

        numerator = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(values))
        denominator = sum((i - x_mean) ** 2 for i in range(n))

        if denominator == 0 or y_mean == 0:
            return 0.0

        slope = numerator / denominator
        return slope / y_mean  # Normalized

    def _generate_basic_insight(
        self,
        daily_totals: Dict[str, Dict[str, float]],
        patterns: List[Dict[str, Any]],
        goal: Optional[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Generate basic insight without LLM."""
        if not daily_totals:
            return {
                "summary": "本周暂无数据记录 / No data recorded this week",
                "patterns": [],
                "recommendations": [],
                "confidence": 1.0,
                "ai_powered": False
            }

        days = sorted(daily_totals.keys())
        avg_kcal = sum(daily_totals[d]["kcal"] for d in days) / len(days)
        avg_protein = sum(daily_totals[d]["protein_g"] for d in days) / len(days)

        summary_parts = [
            f"本周记录 {len(days)} 天",
            f"平均每日摄入 {avg_kcal:.0f} kcal",
            f"蛋白质 {avg_protein:.0f}g"
        ]

        recommendations = []
        for p in patterns:
            if p["type"] == "low_protein":
                recommendations.append("建议增加优质蛋白摄入（鸡胸肉、鱼、豆腐）/ Increase protein intake")
            elif p["type"] == "over_target":
                recommendations.append("建议控制每餐份量或减少高热量食物 / Consider portion control")
            elif p["type"] == "irregular":
                recommendations.append("建议保持规律进餐时间 / Maintain regular meal times")

        return {
            "summary": "，".join(summary_parts),
            "patterns": patterns,
            "recommendations": recommendations,
            "confidence": 0.7,
            "ai_powered": False
        }


# Singleton instance
_insight_service: Optional[InsightService] = None


def get_insight_service() -> InsightService:
    """Get or create the insight service singleton."""
    global _insight_service
    if _insight_service is None:
        _insight_service = InsightService()
    return _insight_service
