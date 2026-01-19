import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
from PIL import Image
import io

from ai_service import AzureOpenAIVisionService, AzureClaudeVisionService, AIServiceError
from database import Database
from nutrition_service import NutritionService


class Settings(BaseSettings):
    # Azure OpenAI (GPT-4o fallback)
    AZURE_OPENAI_ENDPOINT: str = ""
    AZURE_OPENAI_API_KEY: str = ""
    AZURE_OPENAI_DEPLOYMENT: str = ""
    AZURE_OPENAI_API_VERSION: str = "2024-02-15-preview"

    # Azure Claude (primary - better recognition)
    AZURE_CLAUDE_ENDPOINT: str = ""
    AZURE_CLAUDE_API_KEY: str = ""
    AZURE_CLAUDE_MODEL: str = "claude-sonnet-4-5-20250929"

    # Vision service selection: "claude", "openai", or "auto" (try claude first, fallback to openai)
    VISION_SERVICE: str = "openai"

    # App
    DB_PATH: str = "app.db"
    MAX_IMAGE_BYTES: int = 4 * 1024 * 1024
    IMAGE_MAX_SIDE: int = 1280
    IMAGE_JPEG_QUALITY: int = 75

    class Config:
        env_file = ".env"


settings = Settings()

db = Database(settings.DB_PATH)
nutrition = NutritionService(db)

# Initialize vision service based on configuration
def _create_vision_service():
    service_type = settings.VISION_SERVICE.lower()

    # OpenAI GPT-4o (default, reliable)
    if service_type == "openai":
        if settings.AZURE_OPENAI_ENDPOINT and settings.AZURE_OPENAI_API_KEY and settings.AZURE_OPENAI_DEPLOYMENT:
            print(f"Using OpenAI vision service: {settings.AZURE_OPENAI_DEPLOYMENT}")
            return AzureOpenAIVisionService(
                endpoint=settings.AZURE_OPENAI_ENDPOINT,
                api_key=settings.AZURE_OPENAI_API_KEY,
                deployment=settings.AZURE_OPENAI_DEPLOYMENT,
                api_version=settings.AZURE_OPENAI_API_VERSION,
            )

    # Claude (if explicitly selected)
    if service_type == "claude":
        claude_key = settings.AZURE_CLAUDE_API_KEY or settings.AZURE_OPENAI_API_KEY
        if claude_key:
            print(f"Using Claude vision service: {settings.AZURE_CLAUDE_MODEL}")
            return AzureClaudeVisionService(
                endpoint=settings.AZURE_CLAUDE_ENDPOINT,
                api_key=claude_key,
                model=settings.AZURE_CLAUDE_MODEL,
                timeout_s=60.0,
            )

    # Auto mode: try OpenAI first (more reliable), then Claude
    if service_type == "auto":
        if settings.AZURE_OPENAI_ENDPOINT and settings.AZURE_OPENAI_API_KEY and settings.AZURE_OPENAI_DEPLOYMENT:
            print(f"[Auto] Using OpenAI vision service: {settings.AZURE_OPENAI_DEPLOYMENT}")
            return AzureOpenAIVisionService(
                endpoint=settings.AZURE_OPENAI_ENDPOINT,
                api_key=settings.AZURE_OPENAI_API_KEY,
                deployment=settings.AZURE_OPENAI_DEPLOYMENT,
                api_version=settings.AZURE_OPENAI_API_VERSION,
            )
        claude_key = settings.AZURE_CLAUDE_API_KEY or settings.AZURE_OPENAI_API_KEY
        if claude_key:
            print(f"[Auto] Using Claude vision service: {settings.AZURE_CLAUDE_MODEL}")
            return AzureClaudeVisionService(
                endpoint=settings.AZURE_CLAUDE_ENDPOINT,
                api_key=claude_key,
                model=settings.AZURE_CLAUDE_MODEL,
                timeout_s=60.0,
            )

    print("WARNING: No vision service configured!")
    return None

ai = _create_vision_service()

app = FastAPI(title="Food AI Nutrition API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # MVP: tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _require_user_id(x_user_id: Optional[str]) -> str:
    return (x_user_id or "demo").strip()


def _iso_now_local() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


def _today_iso() -> str:
    return date.today().isoformat()


def _compress_image_to_jpeg(image_bytes: bytes, max_side: int, quality: int) -> bytes:
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    scale = min(1.0, float(max_side) / float(max(w, h)))
    if scale < 1.0:
        img = img.resize((int(w * scale), int(h * scale)))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=quality, optimize=True)
    return out.getvalue()


# ----------------- Schemas -----------------
class AnalyzeResponse(BaseModel):
    ai: Dict[str, Any]
    meal_preview: Dict[str, Any]


class MealItemIn(BaseModel):
    name: str
    weight_g: float = Field(..., ge=0)
    nutrition: Optional[Dict[str, Any]] = None
    confidence: Optional[float] = None
    manually_corrected: bool = False


class MealCreateIn(BaseModel):
    meal_type: str = Field(..., pattern="^(breakfast|lunch|dinner|snack)$")
    eaten_at: Optional[str] = None  # ISO local datetime
    items: List[Dict[str, Any]]
    totals: Dict[str, Any]
    image_path: Optional[str] = None


class GoalSetIn(BaseModel):
    goal_type: str = Field(..., description="cut/bulk/health or Chinese labels")
    profile: Dict[str, Any]


# ----------------- Routes -----------------
@app.get("/api/health")
def health():
    return {"ok": True, "time": _iso_now_local()}


@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(
    file: UploadFile = File(...),
    x_user_id: Optional[str] = Header(default=None),
):
    user_id = _require_user_id(x_user_id)

    if ai is None:
        raise HTTPException(status_code=500, detail="AI vision service is not configured. Please set AZURE_OPENAI_API_KEY or AZURE_CLAUDE_API_KEY.")

    raw = await file.read()
    if len(raw) > settings.MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="image too large")

    try:
        jpeg = _compress_image_to_jpeg(raw, settings.IMAGE_MAX_SIDE, settings.IMAGE_JPEG_QUALITY)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid image")

    try:
        ai_result = ai.analyze_food_image(jpeg, mime="image/jpeg")
    except AIServiceError as e:
        raise HTTPException(status_code=502, detail=str(e))

    meal_preview = nutrition.build_meal_from_ai(ai_result)

    return {"ai": ai_result, "meal_preview": meal_preview}


@app.get("/api/meals")
def get_today_meals(x_user_id: Optional[str] = Header(default=None), day: Optional[str] = None):
    user_id = _require_user_id(x_user_id)
    meals = db.list_meals_by_date(user_id, day_iso=day)
    return {"day": day or _today_iso(), "meals": meals}


@app.post("/api/meals")
def create_meal(payload: MealCreateIn, x_user_id: Optional[str] = Header(default=None)):
    user_id = _require_user_id(x_user_id)
    eaten_at = payload.eaten_at or _iso_now_local()

    meal = db.create_meal(
        user_id=user_id,
        meal_type=payload.meal_type,
        eaten_at=eaten_at,
        items=payload.items,
        totals=payload.totals,
        image_path=payload.image_path,
    )
    return {"meal": meal}


@app.get("/api/stats/daily")
def stats_daily(x_user_id: Optional[str] = Header(default=None), day: Optional[str] = None):
    user_id = _require_user_id(x_user_id)
    meals = db.list_meals_by_date(user_id, day_iso=day)
    totals = nutrition.aggregate_totals(meals)
    goal = db.get_user_goal(user_id)
    return {"day": day or _today_iso(), "totals": totals, "goal": goal, "meals_count": len(meals)}


@app.get("/api/stats/weekly")
def stats_weekly(x_user_id: Optional[str] = Header(default=None)):
    user_id = _require_user_id(x_user_id)

    # week range (local)
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    days = [(week_start + timedelta(days=i)) for i in range(7)]

    series = []
    for d in days:
        meals = db.list_meals_by_date(user_id, day_iso=d.isoformat())
        totals = nutrition.aggregate_totals(meals)
        series.append({"day": d.isoformat(), "totals": totals, "meals_count": len(meals)})

    return {"week_start": week_start.isoformat(), "days": series}


@app.post("/api/user/goal")
def set_goal(payload: GoalSetIn, x_user_id: Optional[str] = Header(default=None)):
    user_id = _require_user_id(x_user_id)
    targets = nutrition.compute_targets(payload.goal_type, payload.profile)
    saved = db.upsert_user_goal(user_id, payload.goal_type, payload.profile, targets)
    return {"goal": saved}


@app.get("/api/recommendations")
def recommendations(x_user_id: Optional[str] = Header(default=None)):
    user_id = _require_user_id(x_user_id)
    meals = db.list_meals_by_date(user_id, day_iso=_today_iso())
    totals = nutrition.aggregate_totals(meals)
    goal = db.get_user_goal(user_id)
    rec = nutrition.recommend_next_meal(goal, totals)
    return {"day": _today_iso(), "today_totals": totals, "goal": goal, "recommendation": rec}


# ----------------- Static Files -----------------
# Serve static files (frontend) - must be after API routes
STATIC_DIR = Path(__file__).parent

@app.get("/")
async def serve_index():
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/index.html")
async def serve_index_html():
    return FileResponse(STATIC_DIR / "index.html")

@app.get("/dashboard.html")
async def serve_dashboard():
    return FileResponse(STATIC_DIR / "dashboard.html")

@app.get("/style.css")
async def serve_css():
    return FileResponse(STATIC_DIR / "style.css", media_type="text/css")

@app.get("/app.js")
async def serve_js():
    return FileResponse(STATIC_DIR / "app.js", media_type="application/javascript")