"""
InsightFlow Local LLM Provider

使用 llama.cpp 服务器（OpenAI 兼容 API）生成洞察
支持本地运行的开源模型如 Qwen、Mistral、LLaMA 等
"""

import os
import json
import httpx
from typing import Dict, Any, Optional, List
from dataclasses import dataclass
from datetime import datetime

from ..core.event import Event, Insight


@dataclass
class LocalLLMConfig:
    """本地 LLM 配置"""
    base_url: str = "http://localhost:8080"  # llama.cpp 服务器地址
    model: str = "local"  # 模型名称（可选，用于日志）
    timeout: float = 120.0  # 超时时间（本地模型可能较慢）
    max_tokens: int = 1000
    temperature: float = 0.7

    @classmethod
    def from_env(cls) -> "LocalLLMConfig":
        """从环境变量加载配置"""
        return cls(
            base_url=os.getenv("LOCAL_LLM_BASE_URL", "http://localhost:8080"),
            model=os.getenv("LOCAL_LLM_MODEL", "local"),
            timeout=float(os.getenv("LOCAL_LLM_TIMEOUT", "120")),
            max_tokens=int(os.getenv("LOCAL_LLM_MAX_TOKENS", "1000")),
            temperature=float(os.getenv("LOCAL_LLM_TEMPERATURE", "0.7"))
        )


class LocalLLMProvider:
    """本地 LLM 提供者（llama.cpp OpenAI 兼容 API）"""

    def __init__(self, config: Optional[LocalLLMConfig] = None):
        """
        初始化 LLM 提供者

        Args:
            config: 本地 LLM 配置，如果不提供则从环境变量加载
        """
        self.config = config or LocalLLMConfig.from_env()
        self._client: Optional[httpx.AsyncClient] = None

    @property
    def client(self) -> httpx.AsyncClient:
        """获取 HTTP 客户端"""
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.config.timeout)
        return self._client

    async def close(self) -> None:
        """关闭客户端连接"""
        if self._client:
            await self._client.aclose()
            self._client = None

    async def health_check(self) -> bool:
        """检查本地 LLM 服务是否可用"""
        try:
            response = await self.client.get(f"{self.config.base_url}/health")
            return response.status_code == 200
        except Exception:
            return False

    async def generate_insight(
        self,
        events_data: Dict[str, Any],
        patterns: List[str],
        topic: Optional[str] = None,
        custom_prompt: Optional[str] = None
    ) -> Insight:
        """
        基于事件数据生成洞察

        Args:
            events_data: 预处理的事件数据（来自 TimeWindowAggregator）
            patterns: 检测到的模式描述列表
            topic: 可选的主题/焦点
            custom_prompt: 自定义提示词

        Returns:
            Insight 对象
        """
        system_prompt = self._build_system_prompt(topic)
        user_prompt = self._build_user_prompt(events_data, patterns, custom_prompt)

        response = await self._call_api(system_prompt, user_prompt)

        # 解析 LLM 响应
        return self._parse_response(response, events_data)

    def _build_system_prompt(self, topic: Optional[str] = None) -> str:
        """构建系统提示词"""
        base_prompt = """你是 InsightFlow 数据分析助手，专门分析多模态时序数据并发现有价值的洞察。

你的任务是：
1. 分析给定时间窗口内的事件数据和检测到的模式
2. 识别有意义的趋势、异常和关联
3. 生成简洁但有价值的洞察摘要
4. 提供具体可行的建议

输出要求：
- 摘要应简洁明了（2-4句话）
- 模式描述要具体
- 建议要具体可行
- 使用中文回复
- 输出 JSON 格式"""

        if topic:
            base_prompt += f"\n\n特别关注点：{topic}"

        return base_prompt

    def _build_user_prompt(
        self,
        events_data: Dict[str, Any],
        patterns: List[str],
        custom_prompt: Optional[str] = None
    ) -> str:
        """构建用户提示词"""
        prompt_parts = [
            f"## 时间窗口\n{events_data.get('window', '未知')}",
            f"\n## 时间范围\n开始: {events_data.get('time_range', {}).get('start', '未知')}\n"
            f"结束: {events_data.get('time_range', {}).get('end', '未知')}",
        ]

        # 统计信息
        stats = events_data.get("statistics", {})
        prompt_parts.append(f"\n## 统计数据\n"
                          f"- 总事件数: {stats.get('total_events', 0)}\n"
                          f"- 平均每小时: {stats.get('avg_per_hour', 0)}\n"
                          f"- 峰值时段: {stats.get('peak_hour', '无')}")

        if stats.get("by_type"):
            prompt_parts.append(f"- 按类型分布: {json.dumps(stats['by_type'], ensure_ascii=False)}")

        if stats.get("by_source"):
            prompt_parts.append(f"- 按来源分布: {json.dumps(stats['by_source'], ensure_ascii=False)}")

        # 检测到的模式
        if patterns:
            prompt_parts.append(f"\n## 检测到的模式\n" + "\n".join(f"- {p}" for p in patterns))
        else:
            prompt_parts.append("\n## 检测到的模式\n无明显模式")

        # 内容样本（本地模型限制更多，减少样本数）
        samples = events_data.get("content_samples", [])
        if samples:
            prompt_parts.append(f"\n## 内容样本（最近 {min(len(samples), 5)} 条）\n" +
                              "\n".join(samples[:5]))  # 本地模型限制样本数量

        # 自定义提示
        if custom_prompt:
            prompt_parts.append(f"\n## 额外分析要求\n{custom_prompt}")

        prompt_parts.append("\n请基于以上数据生成洞察，输出JSON格式：\n"
                          "```json\n"
                          "{\n"
                          '  "summary": "洞察摘要（2-4句话）",\n'
                          '  "patterns": ["具体模式1", "具体模式2"],\n'
                          '  "recommendations": ["具体建议1", "具体建议2"],\n'
                          '  "confidence": 0.8\n'
                          "}\n```")

        return "\n".join(prompt_parts)

    async def _call_api(self, system_prompt: str, user_prompt: str) -> str:
        """调用本地 LLM API (OpenAI 兼容格式)"""
        url = f"{self.config.base_url.rstrip('/')}/v1/chat/completions"

        headers = {
            "Content-Type": "application/json"
        }

        payload = {
            "model": self.config.model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens,
            "stream": False
        }

        try:
            response = await self.client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            result = response.json()
            return result["choices"][0]["message"]["content"]
        except httpx.ConnectError:
            raise ConnectionError(f"无法连接到本地 LLM 服务器: {self.config.base_url}")
        except httpx.TimeoutException:
            raise TimeoutError(f"本地 LLM 请求超时（{self.config.timeout}秒）")

    def _parse_response(self, response: str, events_data: Dict[str, Any]) -> Insight:
        """解析 LLM 响应为 Insight 对象"""
        # 尝试提取 JSON
        try:
            # 查找 JSON 块
            json_start = response.find("{")
            json_end = response.rfind("}") + 1
            if json_start >= 0 and json_end > json_start:
                json_str = response[json_start:json_end]
                data = json.loads(json_str)
            else:
                # 如果没有 JSON，使用原始响应作为摘要
                data = {"summary": response}
        except json.JSONDecodeError:
            data = {"summary": response}

        # 解析时间范围
        time_range = events_data.get("time_range", {})
        window_start = None
        window_end = None
        if time_range.get("start"):
            try:
                window_start = datetime.fromisoformat(time_range["start"])
            except (ValueError, TypeError):
                pass
        if time_range.get("end"):
            try:
                window_end = datetime.fromisoformat(time_range["end"])
            except (ValueError, TypeError):
                pass

        return Insight(
            time_window=events_data.get("window", "unknown"),
            summary=data.get("summary", "无法生成洞察"),
            patterns=data.get("patterns", []),
            recommendations=data.get("recommendations", []),
            confidence=data.get("confidence", 0.5),
            source_events_count=events_data.get("statistics", {}).get("total_events", 0),
            window_start=window_start,
            window_end=window_end,
            metadata={"raw_response": response[:500], "provider": "local"}
        )

    async def summarize_observations(
        self,
        observations: List[str],
        topic: Optional[str] = None
    ) -> str:
        """
        对观察内容进行摘要

        Args:
            observations: 观察内容列表
            topic: 可选的主题

        Returns:
            摘要文本
        """
        if not observations:
            return "没有可总结的观察内容"

        system_prompt = """你是一个智能助手，负责总结一系列观察记录。
请提供简洁但全面的摘要，突出重点和发现的模式。使用中文回复。"""

        if topic:
            system_prompt += f"\n特别关注: {topic}"

        # 本地模型限制更多，减少观察数量
        user_prompt = f"以下是 {len(observations)} 条观察记录，请生成摘要：\n\n"
        user_prompt += "\n---\n".join(observations[:15])  # 限制数量

        response = await self._call_api(system_prompt, user_prompt)
        return response
