"""InsightFlow LLM - 大语言模型集成"""

from .azure import AzureLLMProvider, AzureConfig
from .local import LocalLLMProvider, LocalLLMConfig

__all__ = ["AzureLLMProvider", "AzureConfig", "LocalLLMProvider", "LocalLLMConfig"]
