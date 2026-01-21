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
            "You are a professional food recognition and nutrition analysis assistant. "
            "Please carefully analyze the food in this image.\n\n"
            "你是一个专业的食物识别与营养分析助手。请仔细分析这张图片中的食物。\n"
            "あなたはプロの食品認識・栄養分析アシスタントです。この画像の食べ物を分析してください。\n\n"
            "For each recognized food, provide:\n"
            "1. name: Common name (use the food's native language - 中文/日本語/English as appropriate)\n"
            "2. confidence: Recognition confidence (0-1)\n"
            "3. portion: Portion estimate (unit: g, provide min/max/estimated)\n"
            "4. nutrition_per_100g: Nutrition per 100g\n"
            "   - kcal, protein_g, carbs_g, fat_g\n"
            "5. cooking_method: Cooking method\n"
            "6. notes: Notes\n"
            "7. need_user_confirm: Whether user confirmation is needed\n\n"
            "Nutrition reference data:\n"
            "- Rice (cooked) 100g: 116kcal, 2.6g protein, 25.9g carbs, 0.3g fat\n"
            "- Chicken breast 100g: 165kcal, 31g protein, 0g carbs, 3.6g fat\n"
            "- 红烧肉 (braised pork) 100g: 500kcal, 15g protein, 5g carbs, 45g fat\n"
            "- 刺身/Sashimi 100g: 127kcal, 26g protein, 0g carbs, 2g fat\n"
            "- ラーメン/Ramen 100g: 89kcal, 5g protein, 13g carbs, 2g fat\n"
            "- 寿司/Sushi (nigiri) 100g: 150kcal, 6g protein, 22g carbs, 4g fat\n"
            "- 天ぷら/Tempura 100g: 200kcal, 5g protein, 20g carbs, 11g fat\n\n"
            f"Output JSON only, following this structure:\n{json.dumps(schema_hint, ensure_ascii=False, indent=2)}"
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
            "You are a professional food recognition and nutrition analysis assistant. "
            "Identify foods in images and provide portion estimates (grams) and nutrition per 100g. "
            "You have extensive knowledge of food nutrition from various cuisines (Chinese, Japanese, Western, etc.). "
            "Output must be strict JSON with no extra text."
        )

        schema_hint = {
            "foods": [
                {
                    "name": "string (native language name - 中文/日本語/English)",
                    "confidence": 0.85,
                    "portion": {"unit": "g", "min": 100, "max": 200, "estimated": 150},
                    "nutrition_per_100g": {
                        "kcal": 150,
                        "protein_g": 10.0,
                        "carbs_g": 20.0,
                        "fat_g": 5.0
                    },
                    "cooking_method": "string (e.g., stir-fried, braised, steamed, grilled)",
                    "notes": "string",
                    "need_user_confirm": False,
                }
            ],
            "meal_guess": {"meal_type": "breakfast|lunch|dinner|snack|unknown", "confidence": 0.0},
            "overall_confidence": 0.0,
            "warnings": ["string"],
        }

        user_text = (
            "Identify all foods in the image. For each food provide:\n"
            "1. name: Common name (use native language - 中文 for Chinese food, 日本語 for Japanese, English for Western)\n"
            "2. confidence: 0-1 confidence score\n"
            "3. portion: Portion estimate (unit: g, with min/max/estimated)\n"
            "4. nutrition_per_100g: Nutrition per 100g (kcal, protein_g, carbs_g, fat_g)\n"
            "5. cooking_method: Cooking method\n"
            "6. notes: Notes\n"
            "7. need_user_confirm: Whether user confirmation needed\n\n"
            "Nutrition reference:\n"
            "- Rice (cooked) 100g: 116kcal, 2.6g protein, 25.9g carbs, 0.3g fat\n"
            "- Chicken breast 100g: 165kcal, 31g protein, 0g carbs, 3.6g fat\n"
            "- 红烧肉 (braised pork) 100g: 500kcal, 15g protein, 5g carbs, 45g fat\n"
            "- 刺身/Sashimi 100g: 127kcal, 26g protein, 0g carbs, 2g fat\n"
            "- ラーメン/Ramen 100g: 89kcal, 5g protein, 13g carbs, 2g fat\n"
            "- 寿司/Sushi 100g: 150kcal, 6g protein, 22g carbs, 4g fat\n\n"
            f"Output strict JSON: {json.dumps(schema_hint, ensure_ascii=False)}"
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