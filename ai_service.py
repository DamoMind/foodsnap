import base64
import json
from typing import Any, Dict, List, Optional, Protocol

import httpx


class AIServiceError(RuntimeError):
    pass


class VisionServiceProtocol(Protocol):
    """Protocol for vision services to ensure consistent interface."""
    def analyze_food_image(self, image_bytes: bytes, mime: str = "image/jpeg") -> Dict[str, Any]:
        ...


class AzureClaudeVisionService:
    """
    Azure Anthropic Claude vision via Messages API.

    Uses Claude Sonnet 4.5 for high-quality food recognition.
    Endpoint: https://{resource}.openai.azure.com/anthropic/v1/messages
    """

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        model: str = "claude-sonnet-4-5-20250929",
        timeout_s: float = 60.0,
    ):
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout_s = timeout_s

    def _messages_url(self) -> str:
        return f"{self.endpoint}/messages"

    @staticmethod
    def _image_to_base64(image_bytes: bytes) -> str:
        return base64.b64encode(image_bytes).decode("utf-8")

    def analyze_food_image(self, image_bytes: bytes, mime: str = "image/jpeg") -> Dict[str, Any]:
        """
        Returns structured JSON (same schema as GPT service).
        """
        b64_image = self._image_to_base64(image_bytes)

        schema_hint = {
            "foods": [
                {
                    "name": "string (中文常见名)",
                    "confidence": 0.85,
                    "portion": {"unit": "g", "min": 100, "max": 200, "estimated": 150},
                    "nutrition_per_100g": {
                        "kcal": 150,
                        "protein_g": 10.0,
                        "carbs_g": 20.0,
                        "fat_g": 5.0
                    },
                    "cooking_method": "string (如：清炒、红烧、蒸等)",
                    "notes": "string",
                    "need_user_confirm": False,
                }
            ],
            "meal_guess": {"meal_type": "breakfast|lunch|dinner|snack|unknown", "confidence": 0.0},
            "overall_confidence": 0.0,
            "warnings": ["string"],
        }

        user_text = (
            "你是一个专业的食物识别与营养分析助手。请仔细分析这张图片中的食物。\n\n"
            "对于每个识别出的食物，请提供：\n"
            "1. name：中文常见名称\n"
            "2. confidence：识别置信度 (0-1)\n"
            "3. portion：份量估计 (单位g，给出min/max/estimated)\n"
            "4. nutrition_per_100g：每100克营养成分\n"
            "   - kcal: 热量\n"
            "   - protein_g: 蛋白质\n"
            "   - carbs_g: 碳水化合物\n"
            "   - fat_g: 脂肪\n"
            "5. cooking_method：烹饪方式\n"
            "6. notes：备注说明\n"
            "7. need_user_confirm：是否需要用户确认\n\n"
            "营养数据参考：\n"
            "- 米饭(熟)每100g: 116kcal, 2.6g蛋白, 25.9g碳水, 0.3g脂肪\n"
            "- 鸡胸肉每100g: 165kcal, 31g蛋白, 0g碳水, 3.6g脂肪\n"
            "- 红烧肉每100g: 500kcal, 15g蛋白, 5g碳水, 45g脂肪\n"
            "- 西兰花每100g: 34kcal, 2.8g蛋白, 6.6g碳水, 0.4g脂肪\n"
            "- 鸡蛋每100g: 143kcal, 13g蛋白, 1.1g碳水, 9.5g脂肪\n\n"
            f"请只输出JSON格式，结构如下：\n{json.dumps(schema_hint, ensure_ascii=False, indent=2)}"
        )

        payload = {
            "model": self.model,
            "max_tokens": 2048,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": mime,
                                "data": b64_image
                            }
                        },
                        {
                            "type": "text",
                            "text": user_text
                        }
                    ]
                }
            ]
        }

        headers = {
            "api-key": self.api_key,
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01"
        }

        try:
            with httpx.Client(timeout=self.timeout_s) as client:
                resp = client.post(self._messages_url(), headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPStatusError as e:
            error_detail = ""
            try:
                error_detail = e.response.text
            except:
                pass
            raise AIServiceError(f"Claude vision request failed: {e.response.status_code} - {error_detail}") from e
        except Exception as e:
            raise AIServiceError(f"Claude vision request failed: {e}") from e

        try:
            # Claude returns content as array
            content_blocks = data.get("content", [])
            text_content = ""
            for block in content_blocks:
                if block.get("type") == "text":
                    text_content = block.get("text", "")
                    break

            # Try to extract JSON from the response
            # Sometimes Claude wraps JSON in markdown code blocks
            if "```json" in text_content:
                text_content = text_content.split("```json")[1].split("```")[0]
            elif "```" in text_content:
                text_content = text_content.split("```")[1].split("```")[0]

            parsed = json.loads(text_content.strip())
            if "foods" not in parsed:
                raise ValueError("missing foods in response")
            return parsed
        except json.JSONDecodeError as e:
            raise AIServiceError(f"Claude vision response parse failed (invalid JSON): {e}\nRaw: {text_content[:500]}") from e
        except Exception as e:
            raise AIServiceError(f"Claude vision response parse failed: {e}") from e


class AzureOpenAIVisionService:
    """
    Azure OpenAI GPT-4V / GPT-4o vision via Chat Completions API.

    Env needed (wired in main.py):
      - AZURE_OPENAI_ENDPOINT: https://{resource}.openai.azure.com
      - AZURE_OPENAI_API_KEY
      - AZURE_OPENAI_DEPLOYMENT: your vision-capable deployment name (e.g. gpt-4o)
      - AZURE_OPENAI_API_VERSION: e.g. 2024-02-15-preview or newer supported by your resource
    """

    def __init__(
        self,
        endpoint: str,
        api_key: str,
        deployment: str,
        api_version: str,
        timeout_s: float = 30.0,
    ):
        self.endpoint = endpoint.rstrip("/")
        self.api_key = api_key
        self.deployment = deployment
        self.api_version = api_version
        self.timeout_s = timeout_s

    def _chat_url(self) -> str:
        return f"{self.endpoint}/openai/deployments/{self.deployment}/chat/completions?api-version={self.api_version}"

    @staticmethod
    def _image_to_data_url(image_bytes: bytes, mime: str) -> str:
        b64 = base64.b64encode(image_bytes).decode("utf-8")
        return f"data:{mime};base64,{b64}"

    def analyze_food_image(self, image_bytes: bytes, mime: str = "image/jpeg") -> Dict[str, Any]:
        """
        Returns structured JSON:
        {
          "foods":[
            {
              "name":"米饭",
              "confidence":0.72,
              "portion":{"unit":"g","min":120,"max":200,"estimated":150},
              "nutrition_per_100g":{"kcal":116,"protein_g":2.6,"carbs_g":25.9,"fat_g":0.3},
              "notes":"...",
              "need_user_confirm":true
            }
          ],
          "meal_guess":{"meal_type":"lunch","confidence":0.55},
          "overall_confidence":0.68,
          "warnings":[...]
        }
        """
        data_url = self._image_to_data_url(image_bytes, mime)

        system = (
            "你是一个专业的食物识别与营养分析助手。"
            "请基于图片识别餐盘中的食物，给出每个食物的份量估计（克）和每100克的营养成分。"
            "你有丰富的食物营养知识，请根据食物类型和烹饪方式准确估算营养。"
            "输出必须是严格 JSON，不要包含任何额外文本。"
        )

        schema_hint = {
            "foods": [
                {
                    "name": "string (中文常见名)",
                    "confidence": 0.85,
                    "portion": {"unit": "g", "min": 100, "max": 200, "estimated": 150},
                    "nutrition_per_100g": {
                        "kcal": 150,
                        "protein_g": 10.0,
                        "carbs_g": 20.0,
                        "fat_g": 5.0
                    },
                    "cooking_method": "string (如：清炒、红烧、蒸等)",
                    "notes": "string",
                    "need_user_confirm": False,
                }
            ],
            "meal_guess": {"meal_type": "breakfast|lunch|dinner|snack|unknown", "confidence": 0.0},
            "overall_confidence": 0.0,
            "warnings": ["string"],
        }

        user_text = (
            "识别图片中的所有食物。对每个食物给出：\n"
            "1. name：中文常见名\n"
            "2. confidence：0-1的置信度\n"
            "3. portion：份量估计(单位g，给出min/max/estimated)\n"
            "4. nutrition_per_100g：每100克营养成分(kcal热量, protein_g蛋白质, carbs_g碳水化合物, fat_g脂肪)\n"
            "5. cooking_method：烹饪方式\n"
            "6. notes：备注\n"
            "7. need_user_confirm：是否需要用户确认\n\n"
            "营养数据要根据食物类型和烹饪方式准确估算。例如：\n"
            "- 米饭(熟)每100g约116kcal, 2.6g蛋白, 25.9g碳水, 0.3g脂肪\n"
            "- 鸡胸肉每100g约165kcal, 31g蛋白, 0g碳水, 3.6g脂肪\n"
            "- 红烧肉每100g约500kcal, 15g蛋白, 5g碳水, 45g脂肪\n\n"
            f"请严格按以下 JSON 结构输出：{json.dumps(schema_hint, ensure_ascii=False)}"
        )

        payload = {
            "messages": [
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": user_text},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                },
            ],
            "temperature": 0.2,
            "max_tokens": 800,
            "response_format": {"type": "json_object"},
        }

        headers = {"api-key": self.api_key, "Content-Type": "application/json"}

        try:
            with httpx.Client(timeout=self.timeout_s) as client:
                resp = client.post(self._chat_url(), headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            raise AIServiceError(f"vision request failed: {e}") from e

        try:
            content = data["choices"][0]["message"]["content"]
            parsed = json.loads(content)
            if "foods" not in parsed:
                raise ValueError("missing foods")
            return parsed
        except Exception as e:
            raise AIServiceError(f"vision response parse failed: {e}") from e