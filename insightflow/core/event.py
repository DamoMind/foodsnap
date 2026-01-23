"""
InsightFlow 核心数据类

Event - 事件数据类
Insight - 洞察数据类
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional
from enum import Enum
import uuid
import json


class EventType(Enum):
    """事件类型枚举"""
    CAMERA_ANALYSIS = "camera_analysis"  # 摄像头分析
    CHAT_MESSAGE = "chat_message"        # 聊天消息
    SENSOR_READING = "sensor_reading"    # 传感器读数
    ACTIVITY_LOG = "activity_log"        # 活动日志
    CUSTOM = "custom"                    # 自定义


@dataclass
class Event:
    """
    事件数据类 - 用于记录各种输入源的数据

    Attributes:
        id: 唯一标识符 (UUID)
        timestamp: 事件发生时间
        event_type: 事件类型
        source: 来源应用标识 (如 "skyeye", "slack")
        session_id: 关联的会话 ID
        content: 主要文本内容
        numeric_value: 数值数据 (用于传感器)
        tags: 标签列表
        data: 扩展数据字典
        metadata: 元数据字典
    """
    event_type: EventType = EventType.CUSTOM
    source: str = ""
    content: Optional[str] = None
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = field(default_factory=datetime.utcnow)
    session_id: Optional[str] = None
    numeric_value: Optional[float] = None
    tags: List[str] = field(default_factory=list)
    data: Dict[str, Any] = field(default_factory=dict)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "id": self.id,
            "timestamp": self.timestamp.isoformat(),
            "event_type": self.event_type.value,
            "source": self.source,
            "session_id": self.session_id,
            "content": self.content,
            "numeric_value": self.numeric_value,
            "tags": self.tags,
            "data": self.data,
            "metadata": self.metadata
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Event":
        """从字典创建"""
        return cls(
            id=d.get("id", str(uuid.uuid4())),
            timestamp=datetime.fromisoformat(d["timestamp"]) if isinstance(d.get("timestamp"), str) else d.get("timestamp", datetime.utcnow()),
            event_type=EventType(d.get("event_type", "custom")),
            source=d.get("source", ""),
            session_id=d.get("session_id"),
            content=d.get("content"),
            numeric_value=d.get("numeric_value"),
            tags=d.get("tags", []),
            data=d.get("data", {}),
            metadata=d.get("metadata", {})
        )


@dataclass
class Insight:
    """
    洞察数据类 - AI 生成的分析结果

    Attributes:
        id: 唯一标识符
        created_at: 创建时间
        time_window: 时间窗口 (如 "1h", "24h", "7d")
        window_start: 窗口开始时间
        window_end: 窗口结束时间
        summary: AI 生成的摘要
        patterns: 检测到的模式列表
        recommendations: 建议列表
        confidence: 置信度 (0-1)
        source_events_count: 来源事件数量
        source_event_ids: 来源事件 ID 列表
        metadata: 元数据
    """
    time_window: str = "1h"
    summary: str = ""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    created_at: datetime = field(default_factory=datetime.utcnow)
    window_start: Optional[datetime] = None
    window_end: Optional[datetime] = None
    patterns: List[str] = field(default_factory=list)
    recommendations: List[str] = field(default_factory=list)
    confidence: float = 0.0
    source_events_count: int = 0
    source_event_ids: List[str] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        """转换为字典"""
        return {
            "id": self.id,
            "created_at": self.created_at.isoformat(),
            "time_window": self.time_window,
            "window_start": self.window_start.isoformat() if self.window_start else None,
            "window_end": self.window_end.isoformat() if self.window_end else None,
            "summary": self.summary,
            "patterns": self.patterns,
            "recommendations": self.recommendations,
            "confidence": self.confidence,
            "source_events_count": self.source_events_count,
            "source_event_ids": self.source_event_ids,
            "metadata": self.metadata
        }

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Insight":
        """从字典创建"""
        return cls(
            id=d.get("id", str(uuid.uuid4())),
            created_at=datetime.fromisoformat(d["created_at"]) if isinstance(d.get("created_at"), str) else d.get("created_at", datetime.utcnow()),
            time_window=d.get("time_window", "1h"),
            window_start=datetime.fromisoformat(d["window_start"]) if d.get("window_start") else None,
            window_end=datetime.fromisoformat(d["window_end"]) if d.get("window_end") else None,
            summary=d.get("summary", ""),
            patterns=d.get("patterns", []),
            recommendations=d.get("recommendations", []),
            confidence=d.get("confidence", 0.0),
            source_events_count=d.get("source_events_count", 0),
            source_event_ids=d.get("source_event_ids", []),
            metadata=d.get("metadata", {})
        )
