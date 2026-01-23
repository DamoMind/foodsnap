"""
InsightFlow 时间窗口聚合器

支持多种时间窗口的数据聚合
"""

from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from dataclasses import dataclass

from ..core.event import Event


# 预定义时间窗口配置
TIME_WINDOWS = {
    "1h": timedelta(hours=1),
    "3h": timedelta(hours=3),
    "5h": timedelta(hours=5),
    "24h": timedelta(hours=24),
    "7d": timedelta(days=7),
    "15d": timedelta(days=15),
    "30d": timedelta(days=30),
}


@dataclass
class WindowStats:
    """时间窗口统计结果"""
    window_name: str
    start_time: datetime
    end_time: datetime
    event_count: int
    events_by_type: Dict[str, int]
    events_by_source: Dict[str, int]
    events_by_hour: Dict[str, int]
    avg_events_per_hour: float
    peak_hour: Optional[str]
    unique_sources: int
    unique_types: int


class TimeWindowAggregator:
    """时间窗口聚合器"""

    def __init__(self):
        self.windows = TIME_WINDOWS.copy()

    def add_custom_window(self, name: str, duration: timedelta) -> None:
        """添加自定义时间窗口"""
        self.windows[name] = duration

    def get_window_bounds(
        self,
        window_name: str,
        end_time: Optional[datetime] = None
    ) -> tuple[datetime, datetime]:
        """
        获取时间窗口的开始和结束时间

        Args:
            window_name: 窗口名称 (如 "1h", "24h", "7d")
            end_time: 结束时间，默认为当前时间

        Returns:
            (start_time, end_time) 元组
        """
        if window_name not in self.windows:
            raise ValueError(f"未知的时间窗口: {window_name}")

        end = end_time or datetime.utcnow()
        start = end - self.windows[window_name]
        return start, end

    def aggregate_events(
        self,
        events: List[Event],
        window_name: str = "1h"
    ) -> WindowStats:
        """
        对事件列表进行聚合统计

        Args:
            events: 事件列表
            window_name: 时间窗口名称

        Returns:
            WindowStats 统计结果
        """
        if not events:
            now = datetime.utcnow()
            start, end = self.get_window_bounds(window_name, now)
            return WindowStats(
                window_name=window_name,
                start_time=start,
                end_time=end,
                event_count=0,
                events_by_type={},
                events_by_source={},
                events_by_hour={},
                avg_events_per_hour=0.0,
                peak_hour=None,
                unique_sources=0,
                unique_types=0
            )

        # 时间范围
        timestamps = [e.timestamp for e in events]
        start_time = min(timestamps)
        end_time = max(timestamps)

        # 按类型统计
        events_by_type: Dict[str, int] = {}
        for e in events:
            type_name = e.event_type.value
            events_by_type[type_name] = events_by_type.get(type_name, 0) + 1

        # 按来源统计
        events_by_source: Dict[str, int] = {}
        for e in events:
            events_by_source[e.source] = events_by_source.get(e.source, 0) + 1

        # 按小时统计
        events_by_hour: Dict[str, int] = {}
        for e in events:
            hour_key = e.timestamp.strftime("%Y-%m-%d %H:00")
            events_by_hour[hour_key] = events_by_hour.get(hour_key, 0) + 1

        # 找出峰值小时
        peak_hour = max(events_by_hour.keys(), key=lambda k: events_by_hour[k]) if events_by_hour else None

        # 计算平均每小时事件数
        hours_span = max(1, (end_time - start_time).total_seconds() / 3600)
        avg_events_per_hour = len(events) / hours_span

        return WindowStats(
            window_name=window_name,
            start_time=start_time,
            end_time=end_time,
            event_count=len(events),
            events_by_type=events_by_type,
            events_by_source=events_by_source,
            events_by_hour=events_by_hour,
            avg_events_per_hour=round(avg_events_per_hour, 2),
            peak_hour=peak_hour,
            unique_sources=len(events_by_source),
            unique_types=len(events_by_type)
        )

    def get_content_summary(self, events: List[Event], max_items: int = 20) -> List[str]:
        """
        提取事件内容摘要

        Args:
            events: 事件列表
            max_items: 最大返回条目数

        Returns:
            内容摘要列表
        """
        contents = []
        for e in events:
            if e.content:
                # 截断过长的内容
                content = e.content[:200] + "..." if len(e.content) > 200 else e.content
                contents.append(f"[{e.timestamp.strftime('%H:%M')}] {content}")
            if len(contents) >= max_items:
                break
        return contents

    def prepare_for_llm(
        self,
        events: List[Event],
        window_name: str = "1h"
    ) -> Dict[str, Any]:
        """
        准备用于 LLM 分析的数据

        Args:
            events: 事件列表
            window_name: 时间窗口名称

        Returns:
            结构化数据字典
        """
        stats = self.aggregate_events(events, window_name)
        contents = self.get_content_summary(events)

        return {
            "window": window_name,
            "time_range": {
                "start": stats.start_time.isoformat() if stats.start_time else None,
                "end": stats.end_time.isoformat() if stats.end_time else None
            },
            "statistics": {
                "total_events": stats.event_count,
                "by_type": stats.events_by_type,
                "by_source": stats.events_by_source,
                "avg_per_hour": stats.avg_events_per_hour,
                "peak_hour": stats.peak_hour
            },
            "content_samples": contents
        }
