# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

FoodSnap is an AI-powered food recognition and nutrition tracking PWA. Users photograph meals to get instant nutrition analysis (calories, protein, carbs, fat) with daily tracking, customizable health goals, and multi-language support (Chinese/English).

## Development Commands

```bash
# Install dependencies
pip install -r requirements.txt

# Run development server
uvicorn main:app --reload

# Production server
gunicorn main:app -w 4 -k uvicorn.workers.UvicornWorker

# The app runs at http://localhost:8000
```

## Environment Setup

Copy `.env.example` to `.env` and configure:
- `VISION_SERVICE`: "openai", "claude", or "auto"
- Azure OpenAI: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`
- Azure Claude: `AZURE_CLAUDE_ENDPOINT`, `AZURE_CLAUDE_API_KEY`

## Architecture

### Backend (Python FastAPI)

- **main.py**: FastAPI application entry point, defines all API routes and serves static files
- **ai_service.py**: AI vision service implementations
  - `AzureOpenAIVisionService`: GPT-4o vision via Azure OpenAI Chat Completions API
  - `AzureClaudeVisionService`: Claude vision via Azure Anthropic Messages API
  - Both return structured JSON with food recognition data (name, portion, nutrition_per_100g)
- **database.py**: SQLite database layer with three tables: `meals`, `user_goals`, `food_nutrition`
- **nutrition_service.py**: Nutrition calculations
  - Mifflin-St Jeor formula for TDEE
  - Macro targets based on goal type (cut/bulk/maintain)
  - Meal recommendations based on daily intake vs targets

### Frontend (Vanilla JavaScript PWA)

- **index.html**: Main PWA interface for daily tracking
- **dashboard.html**: Weekly statistics with Chart.js visualizations
- **app.js**: Single-file application logic (~1400 lines)
  - localStorage-based state management (keys: `fs_profile_v1`, `fs_logs_v1`, `fs_lang_v1`, `fs_user_id`)
  - i18n with `zh` and `en` locales
  - Image compression before upload (max 1280px, JPEG quality 0.72)
  - Falls back to local mock data if API unavailable
- **style.css**: Mobile-first CSS with CSS variables for theming

### Alternative Deployment (Cloudflare Workers)

The `cloudflare-deploy/` directory contains a Hono-based TypeScript implementation for Cloudflare Workers with D1 database. This is an alternative deployment option, not the primary backend.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/analyze` | POST | Analyze food image (multipart form with `file` field) |
| `/api/meals` | GET/POST | Get today's meals / Save a meal |
| `/api/stats/daily` | GET | Daily nutrition stats |
| `/api/stats/weekly` | GET | Weekly nutrition stats |
| `/api/user/goal` | POST | Set nutrition goals |
| `/api/recommendations` | GET | Get meal recommendations |

All endpoints accept `X-User-Id` header for user isolation.

## Key Patterns

- AI vision services return consistent JSON schema with `foods[]` array containing `name`, `confidence`, `portion`, `nutrition_per_100g`
- Frontend stores meal data in localStorage with image data URLs (auto-cleans images older than 7 days)
- Nutrition values are calculated per-portion from per-100g values
- The frontend generates unique user IDs client-side for data isolation
