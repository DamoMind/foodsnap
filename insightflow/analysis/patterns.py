"""
InsightFlow 模式检测器

检测事件数据中的趋势、异常和关联模式
"""

from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from dataclasses import dataclass, field
from enum import Enum
import statistics

from ..core.event import Event


class PatternType(Enum):
    """模式类型"""
    TREND_UP = "trend_up"           # 上升趋势
    TREND_DOWN = "trend_down"       # 下降趋势
    STABLE = "stable"               # 稳定
    ANOMALY_SPIKE = "anomaly_spike"  # 异常峰值
    ANOMALY_DROP = "anomaly_drop"   # 异常下降
    PERIODIC = "periodic"           # 周期性
    CORRELATION = "correlation"     # 关联


@dataclass
class DetectedPattern:
    """检测到的模式"""
    pattern_type: PatternType
    description: str
    confidence: float  # 0-1
    affected_period: Optional[tuple[datetime, datetime]] = None
    related_sources: List[str] = field(default_factory=list)
    related_types: List[str] = field(default_factory=list)
    data: Dict[str, Any] = field(default_factory=dict)


class PatternDetector:
    """模式检测器"""

    def __init__(
        self,
        anomaly_threshold: float = 2.0,  # 标准差倍数
        trend_min_periods: int = 3,      # 最小周期数
        min_events_for_analysis: int = 5  # 最小事件数
    ):
        """
        初始化模式检测器

        Args:
            anomaly_threshold: 异常检测阈值（标准差倍数）
            trend_min_periods: 趋势检测最小周期数
            min_events_for_analysis: 分析所需最小事件数
        """
        self.anomaly_threshold = anomaly_threshold
        self.trend_min_periods = trend_min_periods
        self.min_events = min_events_for_analysis

    def detect_all(self, events: List[Event]) -> List[DetectedPattern]:
        """
        执行所有模式检测

        Args:
            events: 事件列表

        Returns:
            检测到的模式列表
        """
        if len(events) < self.min_events:
            return []

        patterns = []

        # 频率趋势检测
        freq_patterns = self.detect_frequency_trends(events)
        patterns.extend(freq_patterns)

        # 异常检测
        anomaly_patterns = self.detect_anomalies(events)
        patterns.extend(anomaly_patterns)

        # 活动模式检测
        activity_patterns = self.detect_activity_patterns(events)
        patterns.extend(activity_patterns)

        return patterns

    def detect_frequency_trends(self, events: List[Event]) -> List[DetectedPattern]:
        """
        检测事件频率趋势

        Args:
            events: 事件列表

        Returns:
            趋势模式列表
        """
        patterns = []

        # 按小时分组统计
        hourly_counts = self._group_by_hour(events)
        if len(hourly_counts) < self.trend_min_periods:
            return patterns

        hours = sorted(hourly_counts.keys())
        counts = [hourly_counts[h] for h in hours]

        # 计算趋势
        trend = self._calculate_trend(counts)

        if trend > 0.3:  # 明显上升
            patterns.append(DetectedPattern(
                pattern_type=PatternType.TREND_UP,
                description=f"事件频率呈上升趋势，从 {counts[0]} 到 {counts[-1]} 每小时",
                confidence=min(trend, 1.0),
                affected_period=(
                    datetime.fromisoformat(hours[0]),
                    datetime.fromisoformat(hours[-1])
                ),
                data={"hourly_counts": dict(zip(hours, counts)), "trend_value": trend}
            ))
        elif trend < -0.3:  # 明显下降
            patterns.append(DetectedPattern(
                pattern_type=PatternType.TREND_DOWN,
                description=f"事件频率呈下降趋势，从 {counts[0]} 到 {counts[-1]} 每小时",
                confidence=min(abs(trend), 1.0),
                affected_period=(
                    datetime.fromisoformat(hours[0]),
                    datetime.fromisoformat(hours[-1])
                ),
                data={"hourly_counts": dict(zip(hours, counts)), "trend_value": trend}
            ))

        return patterns

    def detect_anomalies(self, events: List[Event]) -> List[DetectedPattern]:
        """
        检测异常事件

        Args:
            events: 事件列表

        Returns:
            异常模式列表
        """
        patterns = []

        # 按小时分组
        hourly_counts = self._group_by_hour(events)
        if len(hourly_counts) < 3:
            return patterns

        counts = list(hourly_counts.values())
        mean = statistics.mean(counts)
        if len(counts) > 1:
            stdev = statistics.stdev(counts)
        else:
            stdev = 0

        if stdev == 0:
            return patterns

        # 检测异常时段
        for hour, count in hourly_counts.items():
            z_score = (count - mean) / stdev

            if z_score > self.anomaly_threshold:
                patterns.append(DetectedPattern(
                    pattern_type=PatternType.ANOMALY_SPIKE,
                    description=f"在 {hour} 检测到异常高峰，{count} 事件（正常约 {mean:.1f}）",
                    confidence=min(z_score / 3, 1.0),
                    affected_period=(
                        datetime.fromisoformat(hour),
                        datetime.fromisoformat(hour) + timedelta(hours=1)
                    ),
                    data={"count": count, "mean": mean, "z_score": z_score}
                ))
            elif z_score < -self.anomaly_threshold:
                patterns.append(DetectedPattern(
                    pattern_type=PatternType.ANOMALY_DROP,
                    description=f"在 {hour} 检测到异常低谷，{count} 事件（正常约 {mean:.1f}）",
                    confidence=min(abs(z_score) / 3, 1.0),
                    affected_period=(
                        datetime.fromisoformat(hour),
                        datetime.fromisoformat(hour) + timedelta(hours=1)
                    ),
                    data={"count": count, "mean": mean, "z_score": z_score}
                ))

        return patterns

    def detect_activity_patterns(self, events: List[Event]) -> List[DetectedPattern]:
        """
        检测活动模式（如来源分布、类型分布）

        Args:
            events: 事件列表

        Returns:
            活动模式列表
        """
        patterns = []

        # 按来源统计
        source_counts: Dict[str, int] = {}
        for e in events:
            source_counts[e.source] = source_counts.get(e.source, 0) + 1

        # 检测主导来源
        if source_counts:
            total = sum(source_counts.values())
            dominant_source = max(source_counts.keys(), key=lambda k: source_counts[k])
            dominant_ratio = source_counts[dominant_source] / total

            if dominant_ratio > 0.7 and len(source_counts) > 1:
                patterns.append(DetectedPattern(
                    pattern_type=PatternType.CORRELATION,
                    description=f"来源 '{dominant_source}' 占主导地位（{dominant_ratio:.0%}）",
                    confidence=dominant_ratio,
                    related_sources=[dominant_source],
                    data={"source_distribution": source_counts}
                ))

        # 按类型统计
        type_counts: Dict[str, int] = {}
        for e in events:
            type_counts[e.event_type.value] = type_counts.get(e.event_type.value, 0) + 1

        if type_counts:
            total = sum(type_counts.values())
            dominant_type = max(type_counts.keys(), key=lambda k: type_counts[k])
            dominant_ratio = type_counts[dominant_type] / total

            if dominant_ratio > 0.8 and len(type_counts) > 1:
                patterns.append(DetectedPattern(
                    pattern_type=PatternType.CORRELATION,
                    description=f"事件类型 '{dominant_type}' 占主导地位（{dominant_ratio:.0%}）",
                    confidence=dominant_ratio,
                    related_types=[dominant_type],
                    data={"type_distribution": type_counts}
                ))

        return patterns

    def _group_by_hour(self, events: List[Event]) -> Dict[str, int]:
        """按小时分组统计事件"""
        hourly: Dict[str, int] = {}
        for e in events:
            hour_key = e.timestamp.strftime("%Y-%m-%dT%H:00:00")
            hourly[hour_key] = hourly.get(hour_key, 0) + 1
        return hourly

    def _calculate_trend(self, values: List[float]) -> float:
        """
        计算趋势值

        使用简单线性回归斜率归一化

        Returns:
            趋势值：正数表示上升，负数表示下降，范围约 -1 到 1
        """
        if len(values) < 2:
            return 0.0

        n = len(values)
        x_mean = (n - 1) / 2
        y_mean = sum(values) / n

        numerator = sum((i - x_mean) * (v - y_mean) for i, v in enumerate(values))
        denominator = sum((i - x_mean) ** 2 for i in range(n))

        if denominator == 0:
            return 0.0

        slope = numerator / denominator

        # 归一化：相对于平均值的变化率
        if y_mean != 0:
            normalized_slope = slope / y_mean
        else:
            normalized_slope = slope

        return normalized_slope

    def summarize_patterns(self, patterns: List[DetectedPattern]) -> str:
        """
        生成模式摘要文本

        Args:
            patterns: 检测到的模式列表

        Returns:
            摘要文本
        """
        if not patterns:
            return "未检测到明显模式"

        summaries = []
        for p in patterns:
            confidence_label = "高" if p.confidence > 0.7 else "中" if p.confidence > 0.4 else "低"
            summaries.append(f"- {p.description}（置信度：{confidence_label}）")

        return "\n".join(summaries)
