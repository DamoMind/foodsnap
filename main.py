import os
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings
from PIL import Image
import io

# Rate limiting
try:
    from slowapi import Limiter, _rate_limit_exceeded_handler
    from slowapi.util import get_remote_address
    from slowapi.errors import RateLimitExceeded
    RATE_LIMIT_AVAILABLE = True
except ImportError:
    RATE_LIMIT_AVAILABLE = False
    print("Warning: slowapi not available, rate limiting disabled")

from ai_service import AzureOpenAIVisionService, AzureClaudeVisionService, AIServiceError
from database import Database

# Auth service is optional - gracefully handle missing dependencies
try:
    from auth_service import AuthService, AuthError, _AUTH_DEPS_AVAILABLE
    AUTH_AVAILABLE = _AUTH_DEPS_AVAILABLE  # Check if auth dependencies are actually available
except ImportError as e:
    AUTH_AVAILABLE = False
    AuthService = None
    _AUTH_DEPS_AVAILABLE = False
    class AuthError(Exception):
        pass
    print(f"Warning: Auth service unavailable due to missing dependencies: {e}")
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

    # Authentication
    JWT_SECRET: str = ""  # Required for auth - generate with: python -c "import secrets; print(secrets.token_urlsafe(32))"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 60 * 24  # 24 hours (shorter for security)
    GOOGLE_CLIENT_ID: str = ""
    APPLE_CLIENT_ID: str = ""  # Bundle ID, e.g., "com.yourapp.foodsnap"

    class Config:
        env_file = ".env"


settings = Settings()

db = Database(settings.DB_PATH)
nutrition = NutritionService(db)

# Initialize auth service (optional - only if JWT_SECRET is configured and dependencies available)
auth: Optional["AuthService"] = None
if AUTH_AVAILABLE and settings.JWT_SECRET:
    auth = AuthService(
        jwt_secret=settings.JWT_SECRET,
        jwt_algorithm=settings.JWT_ALGORITHM,
        access_token_expire_minutes=settings.JWT_EXPIRE_MINUTES,
        google_client_id=settings.GOOGLE_CLIENT_ID or None,
        apple_client_id=settings.APPLE_CLIENT_ID or None,
    )
    print("Auth service initialized")

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

# Rate limiting for auth endpoints
if RATE_LIMIT_AVAILABLE:
    limiter = Limiter(key_func=get_remote_address)
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
else:
    limiter = None

# CORS: Allow specific origins only
ALLOWED_ORIGINS = [
    "https://foodsnap.duku.app",
    "https://foodsnap.azurewebsites.net",
    "http://localhost:8000",  # Local development
    "http://127.0.0.1:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-User-Id", "X-Lang"],
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


class ActivityIn(BaseModel):
    """Daily activity/exercise data input."""
    exercise_kcal: float = Field(0, ge=0, description="Calories burned from exercise")
    steps: int = Field(0, ge=0, description="Step count")
    active_minutes: int = Field(0, ge=0, description="Active minutes")
    source: str = Field("manual", description="Data source: manual, healthkit, etc.")


class GoogleAuthIn(BaseModel):
    """Google OAuth login request."""
    id_token: str = Field(..., description="Google ID token from Sign-In SDK")


class AppleAuthIn(BaseModel):
    """Apple OAuth login request."""
    id_token: str = Field(..., description="Apple ID token from Sign-In SDK")
    user_name: Optional[str] = Field(None, description="User's name (only sent on first auth)")


class AuthResponse(BaseModel):
    """Authentication response with JWT token."""
    access_token: str
    token_type: str = "bearer"
    user: Dict[str, Any]


class UserResponse(BaseModel):
    """Current user info response."""
    user: Dict[str, Any]


# ----------------- Helper: Extract user from auth token -----------------
def _get_authenticated_user_id(authorization: Optional[str] = Header(default=None)) -> Optional[str]:
    """Extract user ID from Authorization header if valid JWT token provided."""
    if not authorization or not auth:
        return None

    if not authorization.startswith("Bearer "):
        return None

    token = authorization[7:]  # Remove "Bearer " prefix
    try:
        user_id = auth.get_user_id_from_token(token)
        return user_id
    except AuthError:
        return None


def _require_user_id_with_auth(
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None)
) -> str:
    """Get user ID from auth token or fall back to X-User-Id header."""
    # Try to get from JWT token first
    auth_user_id = _get_authenticated_user_id(authorization)
    if auth_user_id:
        return auth_user_id

    # Fall back to legacy X-User-Id header
    return (x_user_id or "demo").strip()


# ----------------- Routes -----------------
@app.get("/api/health")
def health():
    return {"ok": True, "time": _iso_now_local()}


# ----------------- Authentication Routes -----------------
# Rate limit decorator helper
def rate_limit(limit_string: str):
    """Apply rate limiting if available, otherwise no-op decorator."""
    if limiter:
        return limiter.limit(limit_string)
    return lambda f: f


@app.post("/api/auth/google", response_model=AuthResponse)
@rate_limit("5/minute")  # 5 attempts per minute per IP
async def auth_google(request: Request, payload: GoogleAuthIn):
    """Authenticate with Google OAuth."""
    if not auth:
        raise HTTPException(status_code=501, detail="Authentication not configured")

    if not settings.GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Google OAuth not configured")

    try:
        # Verify Google token and get user info
        google_user = await auth.verify_google_token(payload.id_token)

        # Create or update user in database
        user = db.create_or_update_user(
            provider=google_user["provider"],
            provider_id=google_user["provider_id"],
            email=google_user.get("email"),
            name=google_user.get("name"),
            avatar_url=google_user.get("avatar_url"),
        )

        # Generate JWT token
        access_token = auth.create_access_token(
            user_id=user["id"],
            extra_claims={"email": user.get("email")}
        )

        return {
            "access_token": access_token,
            "token_type": "bearer",
            "user": user
        }

    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/api/auth/apple", response_model=AuthResponse)
@rate_limit("5/minute")  # 5 attempts per minute per IP
async def auth_apple(request: Request, payload: AppleAuthIn):
    """Authenticate with Apple OAuth."""
    if not auth:
        raise HTTPException(status_code=501, detail="Authentication not configured")

    if not settings.APPLE_CLIENT_ID:
        raise HTTPException(status_code=501, detail="Apple OAuth not configured")

    try:
        # Verify Apple token and get user info
        apple_user = await auth.verify_apple_token(payload.id_token)

        # Apple only sends name on first authorization, so use provided name
        name = payload.user_name or apple_user.get("name")

        # Create or update user in database
        user = db.create_or_update_user(
            provider=apple_user["provider"],
            provider_id=apple_user["provider_id"],
            email=apple_user.get("email"),
            name=name,
            avatar_url=None,  # Apple doesn't provide avatars
        )

        # Generate JWT token
        access_token = auth.create_access_token(
            user_id=user["id"],
            extra_claims={"email": user.get("email")}
        )

        return {
            "access_token": access_token,
            "token_type": "bearer",
            "user": user
        }

    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.get("/api/auth/me", response_model=UserResponse)
async def get_current_user(authorization: Optional[str] = Header(default=None)):
    """Get current authenticated user info."""
    if not auth:
        raise HTTPException(status_code=501, detail="Authentication not configured")

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = authorization[7:]
    try:
        user_id = auth.get_user_id_from_token(token)
        user = db.get_user_by_id(user_id)

        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        return {"user": user}

    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/api/auth/link-legacy")
@rate_limit("10/minute")  # 10 attempts per minute per IP
async def link_legacy_account(
    request: Request,
    authorization: Optional[str] = Header(default=None),
    x_user_id: Optional[str] = Header(default=None)
):
    """Link a legacy device user ID to an authenticated account."""
    if not auth:
        raise HTTPException(status_code=501, detail="Authentication not configured")

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")

    if not x_user_id:
        raise HTTPException(status_code=400, detail="X-User-Id header required")

    token = authorization[7:]
    try:
        user_id = auth.get_user_id_from_token(token)

        # Link legacy user to authenticated user
        db.link_legacy_user(user_id, x_user_id.strip())

        # Migrate all legacy data to the new user ID
        db.migrate_legacy_data(x_user_id.strip(), user_id)

        return {"message": "Legacy account linked successfully", "user_id": user_id}

    except AuthError as e:
        raise HTTPException(status_code=401, detail=str(e))


@app.post("/api/analyze", response_model=AnalyzeResponse)
async def analyze(
    file: UploadFile = File(...),
    x_user_id: Optional[str] = Header(default=None),
    x_lang: Optional[str] = Header(default="zh", alias="X-Lang"),
    authorization: Optional[str] = Header(default=None),
):
    user_id = _require_user_id_with_auth(x_user_id, authorization)

    if ai is None:
        raise HTTPException(status_code=500, detail="AI vision service is not configured. Please set AZURE_OPENAI_API_KEY or AZURE_CLAUDE_API_KEY.")

    # Validate language parameter
    lang = x_lang if x_lang in ("zh", "en", "ja") else "zh"

    raw = await file.read()
    if len(raw) > settings.MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="image too large")

    try:
        jpeg = _compress_image_to_jpeg(raw, settings.IMAGE_MAX_SIDE, settings.IMAGE_JPEG_QUALITY)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid image")

    try:
        ai_result = ai.analyze_food_image(jpeg, mime="image/jpeg", lang=lang)
    except AIServiceError as e:
        raise HTTPException(status_code=502, detail=str(e))

    meal_preview = nutrition.build_meal_from_ai(ai_result)

    return {"ai": ai_result, "meal_preview": meal_preview}


@app.get("/api/meals")
def get_today_meals(
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
    day: Optional[str] = None
):
    user_id = _require_user_id_with_auth(x_user_id, authorization)
    meals = db.list_meals_by_date(user_id, day_iso=day)
    return {"day": day or _today_iso(), "meals": meals}


@app.post("/api/meals")
def create_meal(
    payload: MealCreateIn,
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    user_id = _require_user_id_with_auth(x_user_id, authorization)
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
def stats_daily(
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
    day: Optional[str] = None
):
    """Daily stats including activity and net calories."""
    user_id = _require_user_id_with_auth(x_user_id, authorization)
    day_iso = day or _today_iso()

    meals = db.list_meals_by_date(user_id, day_iso=day_iso)
    totals = nutrition.aggregate_totals(meals)
    goal = db.get_user_goal(user_id)
    activity = db.get_activity(user_id, day_iso)

    # Calculate net calories (intake - exercise)
    exercise_kcal = activity.get("exercise_kcal", 0) if activity else 0
    net_kcal = int(totals.get("kcal", 0)) - int(exercise_kcal)

    return {
        "day": day_iso,
        "totals": totals,
        "goal": goal,
        "meals_count": len(meals),
        "activity": activity,
        "net_kcal": net_kcal
    }


@app.get("/api/stats/weekly")
def stats_weekly(
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    user_id = _require_user_id_with_auth(x_user_id, authorization)

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


@app.get("/api/user/profile")
def get_profile(
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    """Get user profile and goals for sync."""
    user_id = _require_user_id_with_auth(x_user_id, authorization)
    goal = db.get_user_goal(user_id)
    return {"user_id": user_id, "goal": goal}


@app.post("/api/user/goal")
def set_goal(
    payload: GoalSetIn,
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    user_id = _require_user_id_with_auth(x_user_id, authorization)
    targets = nutrition.compute_targets(payload.goal_type, payload.profile)
    saved = db.upsert_user_goal(user_id, payload.goal_type, payload.profile, targets)
    return {"goal": saved}


@app.get("/api/meals/sync")
def get_meals_for_sync(
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = 100
):
    """Get meals for a date range (for cloud sync)."""
    user_id = _require_user_id_with_auth(x_user_id, authorization)

    # Default to last 30 days if no dates specified
    if not end_date:
        end_date = _today_iso()
    if not start_date:
        from datetime import timedelta
        start_date = (datetime.fromisoformat(end_date) - timedelta(days=30)).date().isoformat()

    # Convert date to datetime range
    start_iso = f"{start_date}T00:00:00"
    end_iso = f"{end_date}T23:59:59"
    meals = db.list_meals_in_range(user_id, start_iso, end_iso)[:limit]
    return {"start_date": start_date, "end_date": end_date, "meals": meals, "count": len(meals)}


@app.get("/api/activity/sync")
def get_activity_for_sync(
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
):
    """Get activity data for a date range (for cloud sync)."""
    user_id = _require_user_id_with_auth(x_user_id, authorization)

    # Default to last 30 days if no dates specified
    if not end_date:
        end_date = _today_iso()
    if not start_date:
        from datetime import timedelta
        start_date = (datetime.fromisoformat(end_date) - timedelta(days=30)).date().isoformat()

    activities = db.get_activities_in_range(user_id, start_date, end_date)
    return {"start_date": start_date, "end_date": end_date, "activities": activities}


@app.get("/api/recommendations")
def recommendations(
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    user_id = _require_user_id_with_auth(x_user_id, authorization)
    meals = db.list_meals_by_date(user_id, day_iso=_today_iso())
    totals = nutrition.aggregate_totals(meals)
    goal = db.get_user_goal(user_id)
    rec = nutrition.recommend_next_meal(goal, totals)
    return {"day": _today_iso(), "today_totals": totals, "goal": goal, "recommendation": rec}


# ----------------- Activity Tracking -----------------
@app.post("/api/activity")
def save_activity(
    payload: ActivityIn,
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
    day: Optional[str] = None
):
    """Save daily activity/exercise data."""
    user_id = _require_user_id_with_auth(x_user_id, authorization)
    day_iso = day or _today_iso()

    activity = db.upsert_activity(
        user_id=user_id,
        day_iso=day_iso,
        exercise_kcal=payload.exercise_kcal,
        steps=payload.steps,
        active_minutes=payload.active_minutes,
        source=payload.source
    )
    return {"activity": activity}


@app.get("/api/activity")
def get_activity(
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
    day: Optional[str] = None
):
    """Get activity data for a specific day."""
    user_id = _require_user_id_with_auth(x_user_id, authorization)
    day_iso = day or _today_iso()

    activity = db.get_activity(user_id, day_iso)
    return {"day": day_iso, "activity": activity}


# ----------------- Insights (InsightFlow) -----------------
# Initialize insight service with Azure config
_insight_service = None

def _get_insight_service():
    global _insight_service
    if _insight_service is None:
        from insight_service import InsightService
        _insight_service = InsightService(
            db_path="insights.db",
            azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
            azure_api_key=settings.AZURE_OPENAI_API_KEY,
            azure_deployment=settings.AZURE_OPENAI_DEPLOYMENT or "gpt-4o"
        )
    return _insight_service


@app.get("/api/insights/weekly")
async def weekly_insights(
    x_user_id: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
):
    """Get AI-powered weekly nutrition insights."""
    user_id = _require_user_id_with_auth(x_user_id, authorization)

    # Get week's meals
    today = date.today()
    week_start = today - timedelta(days=today.weekday())
    week_end = week_start + timedelta(days=6)

    meals = db.list_meals_in_range(
        user_id,
        f"{week_start.isoformat()}T00:00:00",
        f"{week_end.isoformat()}T23:59:59"
    )
    goal = db.get_user_goal(user_id)

    # Get insights
    insight_svc = _get_insight_service()
    if not insight_svc._started:
        await insight_svc.start()

    insight = await insight_svc.get_weekly_insight(user_id, meals, goal)

    return {
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "meals_count": len(meals),
        "insight": insight
    }


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