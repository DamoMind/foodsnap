"""
InsightFlow - 多模态时序数据洞察中间件

用于收集多模态数据流并通过 AI 发现时间维度上的模式和洞见
"""

from .core.event import Event, EventType, Insight
from .client import InsightFlowClient, InsightFlowConfig, LLMProvider
from .llm.azure import AzureConfig
from .llm.local import LocalLLMConfig

__version__ = "0.1.0"
__all__ = [
    "Event",
    "EventType",
    "Insight",
    "InsightFlowClient",
    "InsightFlowConfig",
    "LLMProvider",
    "AzureConfig",
    "LocalLLMConfig"
]
