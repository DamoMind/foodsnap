"""
InsightFlow Client - 主客户端 API

提供简单易用的接口来记录事件、生成洞察
"""

import asyncio
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any, Callable, Awaitable, Union
from dataclasses import dataclass, field
from enum import Enum

from .core.event import Event, EventType, Insight
from .storage.duckdb import DuckDBStorage
from .analysis.time_window import TimeWindowAggregator, TIME_WINDOWS
from .analysis.patterns import PatternDetector
from .llm.azure import AzureLLMProvider, AzureConfig
from .llm.local import LocalLLMProvider, LocalLLMConfig


class LLMProvider(Enum):
    """LLM 提供者类型"""
    AZURE = "azure"
    LOCAL = "local"


@dataclass
class InsightFlowConfig:
    """InsightFlow 配置"""
    db_path: str = "insightflow.db"
    # LLM 配置
    llm_provider: LLMProvider = LLMProvider.AZURE
    azure_config: Optional[AzureConfig] = None
    local_config: Optional[LocalLLMConfig] = None
    # 分析配置
    anomaly_threshold: float = 2.0
    min_events_for_analysis: int = 5
    auto_insight_interval: Optional[int] = None  # 自动生成洞察的间隔（秒）


class InsightFlowClient:
    """
    InsightFlow 客户端

    使用示例:
        client = InsightFlowClient()
        await client.start()

        # 开始会话
        session_id = await client.start_session(source="skyeye", topic="工作效率")

        # 记录观察
        await client.log_observation(
            content="人物在桌前工作，表情专注",
            source="skyeye",
            session_id=session_id
        )

        # 获取洞察
        insight = await client.get_insight(time_window="1h")
        print(insight.summary)

        await client.stop()
    """

    def __init__(self, config: Optional[InsightFlowConfig] = None):
        """
        初始化客户端

        Args:
            config: 配置对象
        """
        self.config = config or InsightFlowConfig()
        self.storage = DuckDBStorage(self.config.db_path)
        self.aggregator = TimeWindowAggregator()
        self.detector = PatternDetector(
            anomaly_threshold=self.config.anomaly_threshold,
            min_events_for_analysis=self.config.min_events_for_analysis
        )

        # 根据配置选择 LLM 提供者
        self.llm: Union[AzureLLMProvider, LocalLLMProvider]
        self._llm_provider_type = self.config.llm_provider

        if self.config.llm_provider == LLMProvider.LOCAL:
            self.llm = LocalLLMProvider(self.config.local_config)
        else:
            # 默认使用 Azure
            self.llm = AzureLLMProvider(self.config.azure_config)

        self._started = False
        self._insight_callbacks: List[Callable[[Insight], Awaitable[None]]] = []
        self._auto_insight_task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        """启动客户端"""
        if self._started:
            return

        self.storage.initialize()
        self._started = True

        # 启动自动洞察任务
        if self.config.auto_insight_interval:
            self._auto_insight_task = asyncio.create_task(
                self._auto_insight_loop()
            )

    async def stop(self) -> None:
        """停止客户端"""
        if not self._started:
            return

        if self._auto_insight_task:
            self._auto_insight_task.cancel()
            try:
                await self._auto_insight_task
            except asyncio.CancelledError:
                pass

        await self.llm.close()
        self.storage.close()
        self._started = False

    def on_insight(
        self,
        callback: Callable[[Insight], Awaitable[None]],
        min_confidence: float = 0.0
    ) -> None:
        """
        注册洞察回调

        Args:
            callback: 异步回调函数
            min_confidence: 最小置信度阈值
        """
        async def filtered_callback(insight: Insight):
            if insight.confidence >= min_confidence:
                await callback(insight)

        self._insight_callbacks.append(filtered_callback)

    # ========== 会话管理 ==========

    async def start_session(
        self,
        source: str,
        topic: Optional[str] = None
    ) -> str:
        """
        开始新会话

        Args:
            source: 来源标识
            topic: 会话主题

        Returns:
            会话 ID
        """
        self._ensure_started()
        return self.storage.start_session(source, topic)

    async def end_session(self, session_id: str) -> None:
        """结束会话"""
        self._ensure_started()
        self.storage.end_session(session_id)

    async def get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """获取会话信息"""
        self._ensure_started()
        return self.storage.get_session(session_id)

    # ========== 事件记录 ==========

    async def log_event(self, event: Event) -> str:
        """
        记录事件

        Args:
            event: 事件对象

        Returns:
            事件 ID
        """
        self._ensure_started()
        return self.storage.store_event(event)

    async def log_observation(
        self,
        content: str,
        source: str = "default",
        session_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
        data: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        记录观察（摄像头分析结果）

        Args:
            content: 观察内容
            source: 来源
            session_id: 会话 ID
            tags: 标签
            data: 扩展数据

        Returns:
            事件 ID
        """
        event = Event(
            event_type=EventType.CAMERA_ANALYSIS,
            source=source,
            content=content,
            session_id=session_id,
            tags=tags or [],
            data=data or {}
        )
        return await self.log_event(event)

    async def log_chat(
        self,
        content: str,
        source: str = "default",
        session_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
        data: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        记录聊天消息

        Args:
            content: 消息内容
            source: 来源
            session_id: 会话 ID
            tags: 标签
            data: 扩展数据

        Returns:
            事件 ID
        """
        event = Event(
            event_type=EventType.CHAT_MESSAGE,
            source=source,
            content=content,
            session_id=session_id,
            tags=tags or [],
            data=data or {}
        )
        return await self.log_event(event)

    async def log_sensor(
        self,
        value: float,
        source: str = "default",
        session_id: Optional[str] = None,
        tags: Optional[List[str]] = None,
        data: Optional[Dict[str, Any]] = None
    ) -> str:
        """
        记录传感器读数

        Args:
            value: 数值
            source: 来源
            session_id: 会话 ID
            tags: 标签
            data: 扩展数据

        Returns:
            事件 ID
        """
        event = Event(
            event_type=EventType.SENSOR_READING,
            source=source,
            numeric_value=value,
            session_id=session_id,
            tags=tags or [],
            data=data or {}
        )
        return await self.log_event(event)

    # ========== 查询 ==========

    async def get_events(
        self,
        time_window: str = "1h",
        event_types: Optional[List[str]] = None,
        sources: Optional[List[str]] = None,
        session_id: Optional[str] = None,
        limit: int = 1000
    ) -> List[Event]:
        """
        查询事件

        Args:
            time_window: 时间窗口
            event_types: 事件类型过滤
            sources: 来源过滤
            session_id: 会话 ID 过滤
            limit: 返回数量限制

        Returns:
            事件列表
        """
        self._ensure_started()

        start_time, end_time = self.aggregator.get_window_bounds(time_window)

        return self.storage.get_events(
            start_time=start_time,
            end_time=end_time,
            event_types=event_types,
            sources=sources,
            session_id=session_id,
            limit=limit
        )

    async def get_statistics(
        self,
        time_window: str = "1h"
    ) -> Dict[str, Any]:
        """
        获取统计信息

        Args:
            time_window: 时间窗口

        Returns:
            统计数据
        """
        self._ensure_started()

        start_time, end_time = self.aggregator.get_window_bounds(time_window)
        return self.storage.aggregate_events(start_time, end_time)

    # ========== 洞察生成 ==========

    async def get_insight(
        self,
        time_window: str = "1h",
        sources: Optional[List[str]] = None,
        topic: Optional[str] = None,
        session_id: Optional[str] = None,
        save: bool = True
    ) -> Insight:
        """
        生成时间窗口洞察

        Args:
            time_window: 时间窗口 (1h, 3h, 5h, 24h, 7d, 15d, 30d)
            sources: 来源过滤
            topic: 分析主题/焦点
            session_id: 会话 ID 过滤
            save: 是否保存到数据库

        Returns:
            Insight 对象
        """
        self._ensure_started()

        # 获取事件
        events = await self.get_events(
            time_window=time_window,
            sources=sources,
            session_id=session_id
        )

        if not events:
            return Insight(
                time_window=time_window,
                summary="该时间窗口内没有记录到事件",
                confidence=1.0
            )

        # 聚合数据
        events_data = self.aggregator.prepare_for_llm(events, time_window)

        # 检测模式
        patterns = self.detector.detect_all(events)
        pattern_descriptions = [p.description for p in patterns]

        # 调用 LLM 生成洞察
        insight = await self.llm.generate_insight(
            events_data=events_data,
            patterns=pattern_descriptions,
            topic=topic
        )

        # 添加来源事件 ID
        insight.source_event_ids = [e.id for e in events[:100]]

        # 保存洞察
        if save:
            self.storage.store_insight(insight)

        # 触发回调
        for callback in self._insight_callbacks:
            try:
                await callback(insight)
            except Exception:
                pass  # 忽略回调错误

        return insight

    async def get_insights_history(
        self,
        start_time: Optional[datetime] = None,
        time_window: Optional[str] = None,
        limit: int = 100
    ) -> List[Insight]:
        """
        获取历史洞察

        Args:
            start_time: 开始时间
            time_window: 时间窗口类型过滤
            limit: 返回数量限制

        Returns:
            洞察列表
        """
        self._ensure_started()
        return self.storage.get_insights(start_time, time_window, limit)

    async def summarize_session(
        self,
        session_id: str,
        topic: Optional[str] = None
    ) -> str:
        """
        生成会话摘要

        Args:
            session_id: 会话 ID
            topic: 可选的关注主题

        Returns:
            摘要文本
        """
        self._ensure_started()

        # 获取会话事件
        events = self.storage.get_events(
            start_time=datetime.utcnow() - timedelta(days=30),  # 最多 30 天
            session_id=session_id,
            limit=500
        )

        if not events:
            return "该会话没有记录到事件"

        # 提取内容
        observations = [e.content for e in events if e.content]

        # 调用 LLM 摘要
        return await self.llm.summarize_observations(observations, topic)

    # ========== 内部方法 ==========

    def _ensure_started(self) -> None:
        """确保客户端已启动"""
        if not self._started:
            raise RuntimeError("InsightFlowClient 未启动，请先调用 start()")

    async def _auto_insight_loop(self) -> None:
        """自动洞察生成循环"""
        interval = self.config.auto_insight_interval
        while True:
            try:
                await asyncio.sleep(interval)
                # 生成 1 小时洞察
                await self.get_insight(time_window="1h", save=True)
            except asyncio.CancelledError:
                break
            except Exception:
                pass  # 忽略错误，继续循环
