# FoodSnap API Documentation

> Version: 1.1.0  
> Base URL: `https://foodsnap.duku.app/api`

## Authentication

All API endpoints support two authentication methods:

1. **JWT Token** (recommended): Include `Authorization: Bearer <token>` header
2. **User ID Header**: Include `X-User-Id: <user_id>` header (for legacy/demo use)

## Response Format

All API responses follow this standard format:

```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "timestamp": "2024-01-30T12:00:00.000Z"
  }
}
```

Error responses:
```json
{
  "success": false,
  "error": {
    "message": "Error description",
    "code": "ERROR_CODE"
  },
  "meta": {
    "timestamp": "2024-01-30T12:00:00.000Z"
  }
}
```

---

## Endpoints

### Health & Config

#### `GET /api/health`
Check API health status.

**Response:**
```json
{
  "ok": true,
  "time": "2024-01-30 12:00:00",
  "version": "1.1.0"
}
```

#### `GET /api/config`
Get public configuration (Google OAuth client ID, feature flags).

**Response:**
```json
{
  "googleClientId": "xxx.apps.googleusercontent.com",
  "features": {
    "aiAnalysis": true,
    "exerciseTracking": true,
    "supplements": true,
    "healthInsights": true
  }
}
```

---

### Authentication

#### `POST /api/auth/google`
Authenticate with Google OAuth.

**Request Body:**
```json
{
  "id_token": "google_id_token"
}
```
or
```json
{
  "access_token": "google_access_token",
  "user_info": { "sub": "...", "email": "...", "name": "...", "picture": "..." }
}
```

**Response:**
```json
{
  "access_token": "jwt_token",
  "user": {
    "id": "uuid",
    "email": "user@example.com",
    "name": "User Name",
    "avatar_url": "https://...",
    "provider": "google",
    "created_at": "2024-01-30 12:00:00"
  }
}
```

#### `GET /api/auth/me`
Get current authenticated user.

#### `POST /api/auth/link-legacy`
Link legacy device data to authenticated account.

---

### Meals

#### `POST /api/meals`
Create a new meal record.

**Request Body:**
```json
{
  "meal_type": "breakfast|lunch|dinner|snack",
  "items": [
    {
      "name": "Rice",
      "weight_g": 150,
      "kcal": 174,
      "protein_g": 3.9,
      "carbs_g": 38.9,
      "fat_g": 0.45
    }
  ],
  "totals": {
    "kcal": 174,
    "protein_g": 3.9,
    "carbs_g": 38.9,
    "fat_g": 0.45
  },
  "eaten_at": "2024-01-30 12:00:00",
  "image_path": "optional/path/to/image"
}
```

**Validation:**
- `meal_type`: Required, must be one of: breakfast, lunch, dinner, snack
- `items`: Required, must be non-empty array
- `totals`: Required, must include at least `kcal`
- `kcal`: Must be between 0 and 10000

#### `GET /api/meals?day=YYYY-MM-DD`
Get meals for a specific day (defaults to today).

#### `GET /api/meals/sync?limit=500`
Get all meals for syncing (up to limit).

#### `DELETE /api/meals/:id`
Delete a meal record.

---

### User Goals

#### `POST /api/user/goal`
Set user's fitness goal and profile.

**Request Body:**
```json
{
  "goal_type": "cut|bulk|maintain",
  "profile": {
    "sex": "male|female",
    "age": 30,
    "height": 175,
    "weight": 70,
    "activity": 1.375
  }
}
```

Activity levels:
- 1.2 = Sedentary
- 1.375 = Light activity
- 1.55 = Moderate activity
- 1.725 = Very active

#### `GET /api/user/goal`
Get current user's goal.

---

### Activity

#### `POST /api/activity`
Record daily activity data.

**Request Body:**
```json
{
  "day": "2024-01-30",
  "exercise_kcal": 300,
  "steps": 8000,
  "active_minutes": 45,
  "source": "manual|apple_watch|strava"
}
```

#### `GET /api/activity?day=YYYY-MM-DD`
Get activity for a specific day.

#### `GET /api/activity/sync`
Get all activity records for syncing.

---

### Body Metrics

#### `POST /api/body-metrics`
Record body metrics (weight, body fat, etc.).

**Request Body:**
```json
{
  "weight_kg": 70.5,
  "body_fat_pct": 18.5,
  "muscle_mass_kg": 30.0,
  "water_pct": 55.0,
  "notes": "Morning measurement",
  "source": "manual|scale"
}
```

#### `GET /api/body-metrics?limit=30&offset=0`
Get body metrics history.

#### `GET /api/body-metrics/latest`
Get the most recent body metrics.

#### `DELETE /api/body-metrics/:id`
Delete a body metrics record.

---

### Supplements

#### `POST /api/supplements`
Create a new supplement.

**Request Body:**
```json
{
  "name": "Vitamin D",
  "dosage": "1000 IU",
  "frequency": "daily",
  "time_of_day": "morning",
  "notes": "Take with food"
}
```

#### `GET /api/supplements?include_inactive=false`
Get all supplements.

#### `PUT /api/supplements/:id`
Update a supplement.

#### `DELETE /api/supplements/:id`
Delete a supplement.

#### `POST /api/supplements/:id/log`
Log supplement intake.

**Request Body:**
```json
{
  "taken_at": "2024-01-30 08:00:00",
  "notes": "Taken with breakfast"
}
```

#### `GET /api/supplement-logs?day=YYYY-MM-DD`
Get supplement logs for a day.

---

### AI Analysis

#### `POST /api/analyze`
Analyze food image using AI.

**Request:** `multipart/form-data`
- `file`: Image file (JPEG, PNG)
- `lang`: Language code (zh, en, ja)

**Response:**
```json
{
  "ai": {
    "foods": [...],
    "meal_type": "lunch",
    "overall_confidence": 0.85
  },
  "meal_preview": {
    "items": [...],
    "totals": {...}
  }
}
```

#### `POST /api/analyze-exercise`
Analyze exercise screenshot using AI.

**Request:** `multipart/form-data`
- `file`: Screenshot image
- `lang`: Language code

**Response:**
```json
{
  "exercise_kcal": 300,
  "steps": 8000,
  "active_minutes": 45,
  "exercise_type": "running",
  "distance_km": 5.2,
  "confidence": 0.9,
  "source_app": "Apple Watch",
  "summary": "Today's total: 300 kcal burned, 8000 steps, 45 active minutes"
}
```

---

### Statistics & Insights

#### `GET /api/stats/daily?day=YYYY-MM-DD`
Get daily nutrition statistics.

#### `GET /api/stats/weekly`
Get weekly nutrition statistics.

#### `GET /api/recommendations`
Get personalized meal recommendations.

#### `GET /api/insights/weekly`
Get AI-powered weekly diet insights.

#### `GET /api/insights/health?lang=zh`
Get comprehensive AI health insights (diet + exercise + weight + supplements).

---

## Error Codes

| Code | Description |
|------|-------------|
| `MISSING_FIELDS` | Required fields missing in request |
| `INVALID_MEAL_TYPE` | Invalid meal type value |
| `INVALID_ITEMS` | Items array is invalid or empty |
| `INVALID_TOTALS` | Totals object is invalid |
| `INVALID_CALORIES` | Calorie value out of range |
| `INVALID_DATE` | Invalid date format |
| `INVALID_JSON` | Request body is not valid JSON |
| `INTERNAL_ERROR` | Server error |

---

## Rate Limits

- AI Analysis endpoints: 10 requests/minute
- Other endpoints: 100 requests/minute

## Changelog

### v1.1.0 (2024-01-31)
- Added unified error handling with ApiError class
- Added request validation helpers
- Added cache control headers for performance
- Improved response format consistency
- Added API version in health endpoint
- Added feature flags in config endpoint

### v1.0.0 (2024-01-20)
- Initial release
