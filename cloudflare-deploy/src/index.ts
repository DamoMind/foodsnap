/**
 * FoodSnap API - Cloudflare Workers
 * AI食物识别 + 饮食管理后端
 * 包含完整的 Auth、Sync、Activity、Insights API
 * 
 * @version 1.1.0
 * @changelog
 * - 添加统一错误处理中间件
 * - 添加请求验证工具
 * - 改进 API 响应格式一致性
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/cloudflare-workers';
import * as jose from 'jose';

// ============== Error Handling ==============

/** Custom API Error with status code */
class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Standard API response format */
interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    message: string;
    code?: string;
  };
  meta?: {
    timestamp: string;
    requestId?: string;
  };
}

/** Create success response */
function successResponse<T>(data: T, meta?: Record<string, any>): ApiResponse<T> {
  return {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  };
}

/** Create error response */
function errorResponse(message: string, code?: string): ApiResponse {
  return {
    success: false,
    error: { message, code },
    meta: { timestamp: new Date().toISOString() }
  };
}

// ============== Input Validation ==============

/** Validate required fields in request body */
function validateRequired(body: Record<string, any>, fields: string[]): void {
  const missing = fields.filter(f => body[f] === undefined || body[f] === null);
  if (missing.length > 0) {
    throw new ApiError(400, `Missing required fields: ${missing.join(', ')}`, 'MISSING_FIELDS');
  }
}

/** Validate meal type */
function validateMealType(mealType: string): void {
  const validTypes = ['breakfast', 'lunch', 'dinner', 'snack'];
  if (!validTypes.includes(mealType)) {
    throw new ApiError(400, `Invalid meal_type. Must be one of: ${validTypes.join(', ')}`, 'INVALID_MEAL_TYPE');
  }
}

/** Validate numeric range */
function validateRange(value: number, min: number, max: number, fieldName: string): void {
  if (value < min || value > max) {
    throw new ApiError(400, `${fieldName} must be between ${min} and ${max}`, 'OUT_OF_RANGE');
  }
}

/** Sanitize string input (prevent XSS) */
function sanitizeString(input: string, maxLength = 1000): string {
  if (typeof input !== 'string') return '';
  return input.slice(0, maxLength).replace(/[<>]/g, '');
}

// Types
interface Env {
  DB: D1Database;
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_KEY?: string;
  JWT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
}

interface UserGoal {
  user_id: string;
  goal_type: string;
  profile: Record<string, any>;
  targets: Record<string, any>;
  updated_at: string;
}

interface Meal {
  id: number;
  user_id: string;
  meal_type: string;
  eaten_at: string;
  items: Record<string, any>[];
  totals: Record<string, any>;
  image_path: string | null;
  created_at: string;
  updated_at: string;
}

interface MealTotals {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  sugar_g: number;
  sodium_mg: number;
}

interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  provider: string;
  provider_id: string;
  legacy_user_id: string | null;
  created_at: string;
  last_login_at: string;
}

// App
const app = new Hono<{ Bindings: Env; Variables: { userId: string; user?: User } }>();

// CORS
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-User-Id', 'Authorization'],
}));

// Global error handler
app.onError((err, c) => {
  console.error('API Error:', err);
  
  if (err instanceof ApiError) {
    return c.json(errorResponse(err.message, err.code), err.statusCode);
  }
  
  // Handle JSON parse errors
  if (err instanceof SyntaxError && err.message.includes('JSON')) {
    return c.json(errorResponse('Invalid JSON in request body', 'INVALID_JSON'), 400);
  }
  
  // Generic server error
  return c.json(errorResponse('Internal server error', 'INTERNAL_ERROR'), 500);
});

// Request logging middleware (for debugging)
app.use('/api/*', async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  
  // Log slow requests (>2s)
  if (duration > 2000) {
    console.warn(`Slow request: ${c.req.method} ${c.req.path} took ${duration}ms`);
  }
});

// ============== Auth Helpers ==============

async function getJwtSecret(env: Env): Promise<Uint8Array> {
  const secret = env.JWT_SECRET || 'foodsnap-default-secret-change-in-production';
  return new TextEncoder().encode(secret);
}

async function createJwt(userId: string, env: Env): Promise<string> {
  const secret = await getJwtSecret(env);
  const jwt = await new jose.SignJWT({ sub: userId, type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret);
  return jwt;
}

async function verifyJwt(token: string, env: Env): Promise<string | null> {
  try {
    const secret = await getJwtSecret(env);
    const { payload } = await jose.jwtVerify(token, secret);
    if (payload.type !== 'access' || !payload.sub) {
      return null;
    }
    return payload.sub;
  } catch {
    return null;
  }
}

async function verifyGoogleToken(idToken: string, clientId: string): Promise<{
  provider_id: string;
  email: string;
  name: string;
  avatar_url: string | null;
} | null> {
  try {
    const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${idToken}`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as any;
    
    // Verify audience
    if (data.aud !== clientId) {
      console.error('Google token audience mismatch:', data.aud, 'vs', clientId);
      return null;
    }
    
    return {
      provider_id: data.sub,
      email: data.email,
      name: data.name || data.email?.split('@')[0] || 'User',
      avatar_url: data.picture || null,
    };
  } catch (e) {
    console.error('Google token verification failed:', e);
    return null;
  }
}

// User ID middleware - extracts from JWT or X-User-Id header
app.use('/api/*', async (c, next) => {
  let userId = 'demo';
  
  // Try JWT first
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const jwtUserId = await verifyJwt(token, c.env);
    if (jwtUserId) {
      userId = jwtUserId;
      // Optionally load full user
      const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(jwtUserId).first();
      if (user) {
        c.set('user', user as unknown as User);
      }
    }
  }
  
  // Fallback to X-User-Id header
  if (userId === 'demo') {
    userId = c.req.header('X-User-Id') || 'demo';
  }
  
  c.set('userId', userId);
  await next();
});

// Helpers
function isoNow(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function todayIso(): string {
  return new Date().toISOString().substring(0, 10);
}

function generateId(): string {
  return crypto.randomUUID();
}

// ============== Cache Control Helpers ==============

/** Set cache headers for static-like responses */
function setCacheHeaders(c: any, maxAge: number = 60, staleWhileRevalidate: number = 300): void {
  c.header('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${staleWhileRevalidate}`);
}

/** Set no-cache headers for dynamic/sensitive data */
function setNoCacheHeaders(c: any): void {
  c.header('Cache-Control', 'private, no-cache, no-store, must-revalidate');
  c.header('Pragma', 'no-cache');
}

// Nutrition calculation helpers
function computeTargets(goalType: string, profile: Record<string, any>): Record<string, any> {
  const weight = Number(profile.weight) || 70;
  const height = Number(profile.height) || 175;
  const age = Number(profile.age) || 30;
  const sex = profile.sex || 'male';
  const activity = Number(profile.activity) || 1.375;

  const s = sex === 'male' ? 5 : -161;
  const bmr = 10 * weight + 6.25 * height - 5 * age + s;
  let tdee = bmr * activity;

  let kcal = tdee;
  if (goalType === 'cut' || goalType === 'lose_weight' || goalType === '减脂') {
    kcal = tdee * 0.85;
  } else if (goalType === 'bulk' || goalType === 'gain_muscle' || goalType === '增肌') {
    kcal = tdee * 1.10;
  }

  let ratio = { p: 0.25, c: 0.45, f: 0.30 };
  if (goalType === 'cut' || goalType === 'lose_weight') {
    ratio = { p: 0.30, c: 0.40, f: 0.30 };
  } else if (goalType === 'bulk' || goalType === 'gain_muscle') {
    ratio = { p: 0.25, c: 0.50, f: 0.25 };
  }

  return {
    kcal: Math.round(kcal),
    protein_g: Math.round((kcal * ratio.p) / 4),
    carbs_g: Math.round((kcal * ratio.c) / 4),
    fat_g: Math.round((kcal * ratio.f) / 9),
    generated_at: isoNow(),
    method: 'mifflin_st_jeor_simplified'
  };
}

function aggregateTotals(meals: Meal[]): MealTotals {
  const totals: MealTotals = {
    kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0
  };

  for (const meal of meals) {
    const t = meal.totals;
    totals.kcal += Number(t.kcal) || 0;
    totals.protein_g += Number(t.protein_g) || 0;
    totals.carbs_g += Number(t.carbs_g) || 0;
    totals.fat_g += Number(t.fat_g) || 0;
    totals.fiber_g += Number(t.fiber_g) || 0;
    totals.sugar_g += Number(t.sugar_g) || 0;
    totals.sodium_mg += Number(t.sodium_mg) || 0;
  }

  return totals;
}

function recommendNextMeal(goal: UserGoal | null, totals: MealTotals): Record<string, any> {
  if (!goal) {
    return { summary: '请先设置你的饮食目标', actions: [] };
  }

  const targets = goal.targets;
  const diff = {
    kcal: Math.round((targets.kcal || 2000) - totals.kcal),
    protein_g: Math.round((targets.protein_g || 150) - totals.protein_g),
    carbs_g: Math.round((targets.carbs_g || 200) - totals.carbs_g),
    fat_g: Math.round((targets.fat_g || 65) - totals.fat_g)
  };

  const actions: Record<string, any>[] = [];

  if (diff.protein_g > 20) {
    actions.push({
      type: 'increase_protein',
      title: `下一餐补蛋白约 ${diff.protein_g}g`,
      examples: ['鸡胸肉150g', '豆腐300g', '无糖酸奶300g', '鸡蛋2个 + 牛奶250ml']
    });
  }

  if (diff.kcal < 0) {
    actions.push({
      type: 'reduce_calories',
      title: `今日热量已超标 ${Math.abs(diff.kcal)} kcal`,
      examples: ['下一餐选择低热量食物', '增加蔬菜摄入', '减少主食份量']
    });
  }

  if (diff.fat_g < -10) {
    actions.push({
      type: 'reduce_fat',
      title: `脂肪超标 ${Math.abs(diff.fat_g)}g`,
      examples: ['避免油炸食物', '选择瘦肉', '清蒸/水煮烹饪']
    });
  }

  return { summary: '根据你今日摄入与目标差值，给出下一餐可执行建议。', diff_to_target: diff, actions };
}

// ============== Auth API ==============

app.get('/api/health', (c) => {
  // Health check can be cached briefly
  setCacheHeaders(c, 5, 10);
  return c.json({ 
    ok: true, 
    time: isoNow(),
    version: '1.1.0'
  });
});

// Public config (safe to expose)
app.get('/api/config', (c) => {
  // Config rarely changes, cache longer
  setCacheHeaders(c, 300, 600);
  return c.json({
    googleClientId: c.env.GOOGLE_CLIENT_ID || null,
    features: {
      aiAnalysis: true,
      exerciseTracking: true,
      supplements: true,
      healthInsights: true
    }
  });
});

// Google OAuth
app.post('/api/auth/google', async (c) => {
  const googleClientId = c.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) {
    return c.json({ error: 'Google OAuth not configured' }, 500);
  }

  const body = await c.req.json();
  const idToken = body.id_token || body.credential;
  const accessToken = body.access_token;
  const userInfo = body.user_info;
  
  let googleUser = null;

  // Method 1: ID token verification (One Tap flow)
  if (idToken) {
    googleUser = await verifyGoogleToken(idToken, googleClientId);
  }
  // Method 2: Access token + user info (popup flow)
  else if (accessToken && userInfo) {
    // Verify the access token is valid
    try {
      const tokenInfoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
      if (tokenInfoRes.ok) {
        const tokenInfo = await tokenInfoRes.json() as any;
        // Verify the token was issued for our client
        if (tokenInfo.aud === googleClientId || tokenInfo.azp === googleClientId) {
          googleUser = {
            provider_id: userInfo.sub,
            email: userInfo.email,
            name: userInfo.name || userInfo.email?.split('@')[0] || 'User',
            avatar_url: userInfo.picture || null,
          };
        } else {
          console.error('Access token client mismatch:', tokenInfo.aud, tokenInfo.azp, 'vs', googleClientId);
        }
      }
    } catch (e) {
      console.error('Access token verification failed:', e);
    }
  }

  if (!googleUser) {
    return c.json({ error: 'Invalid Google token' }, 401);
  }

  const now = isoNow();
  
  // Check if user exists
  let user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE provider = ? AND provider_id = ?'
  ).bind('google', googleUser.provider_id).first();

  if (user) {
    // Update last login
    await c.env.DB.prepare(
      'UPDATE users SET last_login_at = ?, name = ?, avatar_url = ? WHERE id = ?'
    ).bind(now, googleUser.name, googleUser.avatar_url, user.id).run();
  } else {
    // Create new user
    const userId = generateId();
    await c.env.DB.prepare(`
      INSERT INTO users (id, email, name, avatar_url, provider, provider_id, created_at, last_login_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      userId, googleUser.email, googleUser.name, googleUser.avatar_url,
      'google', googleUser.provider_id, now, now
    ).run();
    
    user = { id: userId, email: googleUser.email, name: googleUser.name, 
             avatar_url: googleUser.avatar_url, provider: 'google', 
             provider_id: googleUser.provider_id, created_at: now, last_login_at: now };
  }

  // Generate JWT
  const token = await createJwt(user.id as string, c.env);

  return c.json({
    access_token: token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url,
      provider: user.provider,
      created_at: user.created_at
    }
  });
});

// Get current user profile
app.get('/api/user/profile', async (c) => {
  const userId = c.get('userId');
  const user = c.get('user');

  if (!user || userId === 'demo') {
    return c.json({ user: null });
  }

  return c.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url,
      provider: user.provider,
      created_at: user.created_at
    }
  });
});

// Get auth status
app.get('/api/auth/me', async (c) => {
  const userId = c.get('userId');
  const user = c.get('user');

  if (!user || userId === 'demo') {
    return c.json({ authenticated: false, user: null });
  }

  return c.json({
    authenticated: true,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatar_url: user.avatar_url,
      provider: user.provider,
      created_at: user.created_at
    }
  });
});

// Link legacy data
app.post('/api/auth/link-legacy', async (c) => {
  const userId = c.get('userId');
  const user = c.get('user');

  if (!user || userId === 'demo') {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const body = await c.req.json();
  const legacyUserId = body.legacy_user_id;

  if (!legacyUserId) {
    return c.json({ error: 'legacy_user_id is required' }, 400);
  }

  // Update user with legacy_user_id
  await c.env.DB.prepare(
    'UPDATE users SET legacy_user_id = ? WHERE id = ?'
  ).bind(legacyUserId, userId).run();

  // Migrate meals from legacy user
  await c.env.DB.prepare(
    'UPDATE meals SET user_id = ? WHERE user_id = ?'
  ).bind(userId, legacyUserId).run();

  // Migrate goals from legacy user
  await c.env.DB.prepare(
    'UPDATE user_goals SET user_id = ? WHERE user_id = ?'
  ).bind(userId, legacyUserId).run();

  // Migrate activity from legacy user
  await c.env.DB.prepare(
    'UPDATE daily_activity SET user_id = ? WHERE user_id = ?'
  ).bind(userId, legacyUserId).run();

  return c.json({ success: true, migrated_from: legacyUserId });
});

// ============== User Goal API ==============

app.post('/api/user/goal', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();

  const { goal_type, profile } = body;
  if (!goal_type || !profile) {
    return c.json({ error: 'goal_type and profile are required' }, 400);
  }

  const targets = computeTargets(goal_type, profile);
  const now = isoNow();

  await c.env.DB.prepare(`
    INSERT OR REPLACE INTO user_goals (user_id, goal_type, profile, targets, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(userId, goal_type, JSON.stringify(profile), JSON.stringify(targets), now).run();

  return c.json({
    goal: { user_id: userId, goal_type, profile, targets, updated_at: now }
  });
});

app.get('/api/user/goal', async (c) => {
  const userId = c.get('userId');

  const result = await c.env.DB.prepare(
    'SELECT * FROM user_goals WHERE user_id = ?'
  ).bind(userId).first();

  if (!result) {
    return c.json({ goal: null });
  }

  return c.json({
    goal: {
      user_id: result.user_id,
      goal_type: result.goal_type,
      profile: JSON.parse(result.profile as string),
      targets: JSON.parse(result.targets as string),
      updated_at: result.updated_at
    }
  });
});

// ============== Meals API ==============

app.post('/api/meals', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();

  const { meal_type, items, totals, eaten_at, image_path } = body;

  // Validate required fields using helper
  validateRequired(body, ['meal_type', 'items', 'totals']);
  validateMealType(meal_type);

  // Validate items is an array with at least one item
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, 'items must be a non-empty array', 'INVALID_ITEMS');
  }

  // Validate totals has required nutritional fields
  if (typeof totals !== 'object' || totals.kcal === undefined) {
    throw new ApiError(400, 'totals must include at least kcal', 'INVALID_TOTALS');
  }

  // Validate nutritional values are reasonable
  if (totals.kcal < 0 || totals.kcal > 10000) {
    throw new ApiError(400, 'kcal must be between 0 and 10000', 'INVALID_CALORIES');
  }

  const now = isoNow();
  const eatenAt = eaten_at || now;

  // Validate eaten_at date format if provided
  if (eaten_at && isNaN(Date.parse(eaten_at))) {
    throw new ApiError(400, 'Invalid eaten_at date format', 'INVALID_DATE');
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO meals (user_id, meal_type, eaten_at, items, totals, image_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, meal_type, eatenAt, JSON.stringify(items), JSON.stringify(totals), image_path || null, now, now).run();

  return c.json(successResponse({
    meal: {
      id: result.meta.last_row_id,
      user_id: userId, meal_type, eaten_at: eatenAt, items, totals,
      image_path: image_path || null, created_at: now, updated_at: now
    }
  }));
});

app.get('/api/meals', async (c) => {
  const userId = c.get('userId');
  const day = c.req.query('day') || todayIso();

  const results = await c.env.DB.prepare(`
    SELECT * FROM meals WHERE user_id = ? AND date(eaten_at) = ? ORDER BY eaten_at ASC
  `).bind(userId, day).all();

  const meals = results.results.map((row: any) => ({
    id: row.id, user_id: row.user_id, meal_type: row.meal_type, eaten_at: row.eaten_at,
    items: JSON.parse(row.items), totals: JSON.parse(row.totals),
    image_path: row.image_path, created_at: row.created_at, updated_at: row.updated_at
  }));

  return c.json({ day, meals });
});

// Sync all meals
app.get('/api/meals/sync', async (c) => {
  const userId = c.get('userId');
  const limit = parseInt(c.req.query('limit') || '500');

  const results = await c.env.DB.prepare(`
    SELECT * FROM meals WHERE user_id = ? ORDER BY eaten_at DESC LIMIT ?
  `).bind(userId, limit).all();

  const meals = results.results.map((row: any) => ({
    id: row.id, user_id: row.user_id, meal_type: row.meal_type, eaten_at: row.eaten_at,
    items: JSON.parse(row.items), totals: JSON.parse(row.totals),
    image_path: row.image_path, created_at: row.created_at, updated_at: row.updated_at
  }));

  return c.json({ meals, count: meals.length });
});

// Delete meal
app.delete('/api/meals/:id', async (c) => {
  const userId = c.get('userId');
  const mealId = c.req.param('id');

  await c.env.DB.prepare(
    'DELETE FROM meals WHERE id = ? AND user_id = ?'
  ).bind(mealId, userId).run();

  return c.json({ success: true });
});

// ============== Activity API ==============

app.post('/api/activity', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();

  const dayIso = body.day || todayIso();
  const exerciseKcal = Number(body.exercise_kcal) || 0;
  const steps = Number(body.steps) || 0;
  const activeMinutes = Number(body.active_minutes) || 0;
  const source = body.source || 'manual';
  const now = isoNow();

  await c.env.DB.prepare(`
    INSERT INTO daily_activity (user_id, day_iso, exercise_kcal, steps, active_minutes, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, day_iso) DO UPDATE SET
      exercise_kcal = excluded.exercise_kcal,
      steps = excluded.steps,
      active_minutes = excluded.active_minutes,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).bind(userId, dayIso, exerciseKcal, steps, activeMinutes, source, now, now).run();

  return c.json({
    activity: { user_id: userId, day_iso: dayIso, exercise_kcal: exerciseKcal, steps, active_minutes: activeMinutes, source }
  });
});

app.get('/api/activity', async (c) => {
  const userId = c.get('userId');
  const day = c.req.query('day') || todayIso();

  const result = await c.env.DB.prepare(
    'SELECT * FROM daily_activity WHERE user_id = ? AND day_iso = ?'
  ).bind(userId, day).first();

  if (!result) {
    return c.json({ activity: null });
  }

  return c.json({
    activity: {
      user_id: result.user_id,
      day_iso: result.day_iso,
      exercise_kcal: result.exercise_kcal,
      steps: result.steps,
      active_minutes: result.active_minutes,
      source: result.source
    }
  });
});

// Sync all activity
app.get('/api/activity/sync', async (c) => {
  const userId = c.get('userId');

  const results = await c.env.DB.prepare(`
    SELECT * FROM daily_activity WHERE user_id = ? ORDER BY day_iso DESC
  `).bind(userId).all();

  const activities = results.results.map((row: any) => ({
    user_id: row.user_id, day_iso: row.day_iso, exercise_kcal: row.exercise_kcal,
    steps: row.steps, active_minutes: row.active_minutes, source: row.source
  }));

  return c.json({ activities, count: activities.length });
});

// ============== Body Metrics API ==============

// Save body metrics (weight, body fat, etc.)
app.post('/api/body-metrics', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();

  const measuredAt = body.measured_at || isoNow();
  const weightKg = body.weight_kg !== undefined ? Number(body.weight_kg) : null;
  const bodyFatPct = body.body_fat_pct !== undefined ? Number(body.body_fat_pct) : null;
  const muscleMassKg = body.muscle_mass_kg !== undefined ? Number(body.muscle_mass_kg) : null;
  const waterPct = body.water_pct !== undefined ? Number(body.water_pct) : null;
  const notes = body.notes || null;
  const source = body.source || 'manual';

  // Calculate BMI if weight is provided and user has height in profile
  let bmi = null;
  if (weightKg) {
    const goalResult = await c.env.DB.prepare(
      'SELECT profile FROM user_goals WHERE user_id = ?'
    ).bind(userId).first() as any;
    
    if (goalResult?.profile) {
      try {
        const profile = JSON.parse(goalResult.profile);
        const heightCm = profile.height;
        if (heightCm) {
          const heightM = heightCm / 100;
          bmi = Math.round((weightKg / (heightM * heightM)) * 10) / 10;
        }
      } catch {}
    }
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO body_metrics (user_id, measured_at, weight_kg, body_fat_pct, muscle_mass_kg, water_pct, bmi, notes, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, measuredAt, weightKg, bodyFatPct, muscleMassKg, waterPct, bmi, notes, source, isoNow()).run();

  return c.json({
    success: true,
    metric: { id: result.meta?.last_row_id, weight_kg: weightKg, body_fat_pct: bodyFatPct, bmi, measured_at: measuredAt }
  });
});

// Get body metrics history
app.get('/api/body-metrics', async (c) => {
  const userId = c.get('userId');
  const limit = Number(c.req.query('limit')) || 30;
  const offset = Number(c.req.query('offset')) || 0;

  const results = await c.env.DB.prepare(`
    SELECT * FROM body_metrics WHERE user_id = ? ORDER BY measured_at DESC LIMIT ? OFFSET ?
  `).bind(userId, limit, offset).all();

  return c.json({
    metrics: results.results,
    count: results.results.length
  });
});

// Get latest body metrics
app.get('/api/body-metrics/latest', async (c) => {
  const userId = c.get('userId');

  const result = await c.env.DB.prepare(
    'SELECT * FROM body_metrics WHERE user_id = ? ORDER BY measured_at DESC LIMIT 1'
  ).bind(userId).first();

  return c.json({ metric: result || null });
});

// Delete body metric
app.delete('/api/body-metrics/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  await c.env.DB.prepare(
    'DELETE FROM body_metrics WHERE id = ? AND user_id = ?'
  ).bind(id, userId).run();

  return c.json({ success: true });
});

// ============== Supplements API ==============

// Create supplement
app.post('/api/supplements', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();

  const name = body.name;
  const dosage = body.dosage || null;
  const frequency = body.frequency || null;
  const timeOfDay = body.time_of_day || null;
  const notes = body.notes || null;
  const now = isoNow();

  if (!name) {
    return c.json({ error: 'Name is required' }, 400);
  }

  const result = await c.env.DB.prepare(`
    INSERT INTO supplements (user_id, name, dosage, frequency, time_of_day, notes, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).bind(userId, name, dosage, frequency, timeOfDay, notes, now, now).run();

  return c.json({
    success: true,
    supplement: { id: result.meta?.last_row_id, name, dosage, frequency, time_of_day: timeOfDay }
  });
});

// Get all supplements
app.get('/api/supplements', async (c) => {
  const userId = c.get('userId');
  const includeInactive = c.req.query('include_inactive') === 'true';

  const query = includeInactive
    ? 'SELECT * FROM supplements WHERE user_id = ? ORDER BY name'
    : 'SELECT * FROM supplements WHERE user_id = ? AND active = 1 ORDER BY name';

  const results = await c.env.DB.prepare(query).bind(userId).all();

  return c.json({ supplements: results.results });
});

// Update supplement
app.put('/api/supplements/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');
  const body = await c.req.json();

  const updates: string[] = [];
  const values: any[] = [];

  if (body.name !== undefined) { updates.push('name = ?'); values.push(body.name); }
  if (body.dosage !== undefined) { updates.push('dosage = ?'); values.push(body.dosage); }
  if (body.frequency !== undefined) { updates.push('frequency = ?'); values.push(body.frequency); }
  if (body.time_of_day !== undefined) { updates.push('time_of_day = ?'); values.push(body.time_of_day); }
  if (body.notes !== undefined) { updates.push('notes = ?'); values.push(body.notes); }
  if (body.active !== undefined) { updates.push('active = ?'); values.push(body.active ? 1 : 0); }

  if (updates.length === 0) {
    return c.json({ error: 'No fields to update' }, 400);
  }

  updates.push('updated_at = ?');
  values.push(isoNow());
  values.push(id);
  values.push(userId);

  await c.env.DB.prepare(`
    UPDATE supplements SET ${updates.join(', ')} WHERE id = ? AND user_id = ?
  `).bind(...values).run();

  return c.json({ success: true });
});

// Delete supplement
app.delete('/api/supplements/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  await c.env.DB.prepare(
    'DELETE FROM supplements WHERE id = ? AND user_id = ?'
  ).bind(id, userId).run();

  return c.json({ success: true });
});

// Log supplement intake
app.post('/api/supplements/:id/log', async (c) => {
  const userId = c.get('userId');
  const supplementId = c.req.param('id');
  const body = await c.req.json();

  const takenAt = body.taken_at || isoNow();
  const notes = body.notes || null;

  const result = await c.env.DB.prepare(`
    INSERT INTO supplement_logs (user_id, supplement_id, taken_at, notes, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(userId, supplementId, takenAt, notes, isoNow()).run();

  return c.json({
    success: true,
    log: { id: result.meta?.last_row_id, supplement_id: supplementId, taken_at: takenAt }
  });
});

// Get supplement logs for a day
app.get('/api/supplement-logs', async (c) => {
  const userId = c.get('userId');
  const day = c.req.query('day') || todayIso();

  const results = await c.env.DB.prepare(`
    SELECT sl.*, s.name as supplement_name, s.dosage
    FROM supplement_logs sl
    JOIN supplements s ON sl.supplement_id = s.id
    WHERE sl.user_id = ? AND date(sl.taken_at) = ?
    ORDER BY sl.taken_at DESC
  `).bind(userId, day).all();

  return c.json({ logs: results.results });
});

// ============== Stats API ==============

app.get('/api/stats/daily', async (c) => {
  const userId = c.get('userId');
  const day = c.req.query('day') || todayIso();

  const mealsResult = await c.env.DB.prepare(`
    SELECT * FROM meals WHERE user_id = ? AND date(eaten_at) = ?
  `).bind(userId, day).all();

  const meals = mealsResult.results.map((row: any) => ({
    totals: JSON.parse(row.totals)
  })) as Meal[];

  const goalResult = await c.env.DB.prepare(
    'SELECT * FROM user_goals WHERE user_id = ?'
  ).bind(userId).first();

  const goal = goalResult ? {
    user_id: goalResult.user_id, goal_type: goalResult.goal_type,
    profile: JSON.parse(goalResult.profile as string),
    targets: JSON.parse(goalResult.targets as string),
    updated_at: goalResult.updated_at
  } : null;

  const totals = aggregateTotals(meals);

  return c.json({ day, totals, goal, meals_count: meals.length });
});

app.get('/api/stats/weekly', async (c) => {
  const userId = c.get('userId');

  const today = new Date();
  const dayOfWeek = today.getDay();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));

  const days: { day: string; totals: MealTotals; meals_count: number }[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(weekStart);
    d.setDate(weekStart.getDate() + i);
    const dayStr = d.toISOString().substring(0, 10);

    const mealsResult = await c.env.DB.prepare(`
      SELECT * FROM meals WHERE user_id = ? AND date(eaten_at) = ?
    `).bind(userId, dayStr).all();

    const meals = mealsResult.results.map((row: any) => ({
      totals: JSON.parse(row.totals)
    })) as Meal[];

    days.push({ day: dayStr, totals: aggregateTotals(meals), meals_count: meals.length });
  }

  return c.json({ week_start: weekStart.toISOString().substring(0, 10), days });
});

app.get('/api/recommendations', async (c) => {
  const userId = c.get('userId');
  const day = todayIso();

  const mealsResult = await c.env.DB.prepare(`
    SELECT * FROM meals WHERE user_id = ? AND date(eaten_at) = ?
  `).bind(userId, day).all();

  const meals = mealsResult.results.map((row: any) => ({
    totals: JSON.parse(row.totals)
  })) as Meal[];

  const goalResult = await c.env.DB.prepare(
    'SELECT * FROM user_goals WHERE user_id = ?'
  ).bind(userId).first();

  const goal = goalResult ? {
    user_id: goalResult.user_id as string, goal_type: goalResult.goal_type as string,
    profile: JSON.parse(goalResult.profile as string),
    targets: JSON.parse(goalResult.targets as string),
    updated_at: goalResult.updated_at as string
  } : null;

  const totals = aggregateTotals(meals);
  const recommendation = recommendNextMeal(goal, totals);

  return c.json({ day, today_totals: totals, goal, recommendation });
});

// ============== Insights API ==============

app.get('/api/insights/weekly', async (c) => {
  const userId = c.get('userId');
  const AI_GATEWAY_URL = c.env.AI_GATEWAY_URL || 'https://edge-ai-gateway.duizhan.app';
  const AI_GATEWAY_KEY = c.env.AI_GATEWAY_KEY;

  // Get this week's data
  const today = new Date();
  const dayOfWeek = today.getDay();
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const weekStartStr = weekStart.toISOString().substring(0, 10);

  const mealsResult = await c.env.DB.prepare(`
    SELECT * FROM meals WHERE user_id = ? AND date(eaten_at) >= ? ORDER BY eaten_at ASC
  `).bind(userId, weekStartStr).all();

  if (mealsResult.results.length === 0) {
    return c.json({ 
      week_start: weekStartStr,
      meals_count: 0,
      insights: null,
      message: '本周还没有饮食记录'
    });
  }

  const meals = mealsResult.results.map((row: any) => ({
    meal_type: row.meal_type,
    eaten_at: row.eaten_at,
    items: JSON.parse(row.items),
    totals: JSON.parse(row.totals)
  }));

  // Get user goal
  const goalResult = await c.env.DB.prepare(
    'SELECT * FROM user_goals WHERE user_id = ?'
  ).bind(userId).first();

  const goal = goalResult ? {
    goal_type: goalResult.goal_type,
    targets: JSON.parse(goalResult.targets as string)
  } : null;

  // Build AI prompt
  const prompt = `你是一位专业的营养师。请分析用户本周的饮食数据，给出健康建议。

用户目标: ${goal ? goal.goal_type : '未设置'}
${goal ? `每日目标: ${goal.targets.kcal}kcal, 蛋白质${goal.targets.protein_g}g, 碳水${goal.targets.carbs_g}g, 脂肪${goal.targets.fat_g}g` : ''}

本周饮食记录 (${meals.length}餐):
${meals.map(m => `- ${m.eaten_at} ${m.meal_type}: ${m.items.map((i: any) => i.name).join(', ')} (${m.totals.kcal}kcal)`).join('\n')}

请分析并返回JSON格式:
{
  "patterns": [
    {"type": "trend_up|trend_down|over_target|under_target|low_protein|irregular", "description": "描述"}
  ],
  "recommendations": ["建议1", "建议2", "建议3"],
  "summary": "总体评价，2-3句话",
  "score": 1-10
}

只返回JSON，不要其他内容。`;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (AI_GATEWAY_KEY) {
      headers['Authorization'] = `Bearer ${AI_GATEWAY_KEY}`;
    }

    const response = await fetch(`${AI_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      return c.json({ week_start: weekStartStr, meals_count: meals.length, insights: null, error: 'AI service unavailable' });
    }

    const aiResult = await response.json() as any;
    const content = aiResult.choices?.[0]?.message?.content || '';

    let insights;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      insights = JSON.parse(jsonMatch[1].trim());
    } catch {
      insights = { summary: content, patterns: [], recommendations: [], score: 5 };
    }

    return c.json({ week_start: weekStartStr, meals_count: meals.length, insights });

  } catch (e: any) {
    return c.json({ week_start: weekStartStr, meals_count: meals.length, insights: null, error: e.message });
  }
});

// Comprehensive health insights (diet + exercise + weight + supplements)
app.get('/api/insights/health', async (c) => {
  const userId = c.get('userId');
  const AI_GATEWAY_URL = c.env.AI_GATEWAY_URL || 'https://edge-ai-gateway.duizhan.app';
  const AI_GATEWAY_KEY = c.env.AI_GATEWAY_KEY;
  const lang = c.req.query('lang') || 'zh';

  // Get last 7 days of data
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().substring(0, 10);

  // Parallel fetch all data
  const [mealsResult, activityResult, weightResult, supplementsResult, logsResult, goalResult] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM meals WHERE user_id = ? AND date(eaten_at) >= ? ORDER BY eaten_at ASC').bind(userId, weekAgoStr).all(),
    c.env.DB.prepare('SELECT * FROM daily_activity WHERE user_id = ? AND day_iso >= ? ORDER BY day_iso ASC').bind(userId, weekAgoStr).all(),
    c.env.DB.prepare('SELECT * FROM body_metrics WHERE user_id = ? AND date(measured_at) >= ? ORDER BY measured_at ASC').bind(userId, weekAgoStr).all(),
    c.env.DB.prepare('SELECT * FROM supplements WHERE user_id = ? AND active = 1').bind(userId).all(),
    c.env.DB.prepare('SELECT * FROM supplement_logs WHERE user_id = ? AND date(taken_at) >= ?').bind(userId, weekAgoStr).all(),
    c.env.DB.prepare('SELECT * FROM user_goals WHERE user_id = ?').bind(userId).first()
  ]);

  // Process data
  const meals = mealsResult.results.map((row: any) => ({
    meal_type: row.meal_type,
    eaten_at: row.eaten_at,
    totals: JSON.parse(row.totals)
  }));

  const activities = activityResult.results.map((row: any) => ({
    day: row.day_iso,
    exercise_kcal: row.exercise_kcal,
    steps: row.steps,
    active_minutes: row.active_minutes
  }));

  const weights = weightResult.results.map((row: any) => ({
    date: row.measured_at,
    weight_kg: row.weight_kg,
    body_fat_pct: row.body_fat_pct
  }));

  const supplements = supplementsResult.results as any[];
  const supplementLogs = logsResult.results as any[];
  
  // Calculate supplement compliance
  const totalDays = 7;
  const supplementDaysLogged: Record<number, Set<string>> = {};
  supplementLogs.forEach((log: any) => {
    const day = log.taken_at.substring(0, 10);
    if (!supplementDaysLogged[log.supplement_id]) supplementDaysLogged[log.supplement_id] = new Set();
    supplementDaysLogged[log.supplement_id].add(day);
  });

  const supplementCompliance = supplements.map(s => ({
    name: s.name,
    days_taken: supplementDaysLogged[s.id]?.size || 0,
    compliance_pct: Math.round(((supplementDaysLogged[s.id]?.size || 0) / totalDays) * 100)
  }));

  const goal = goalResult ? {
    goal_type: goalResult.goal_type,
    targets: JSON.parse(goalResult.targets as string),
    profile: JSON.parse(goalResult.profile as string)
  } : null;

  // Build comprehensive prompt
  const langInstructions: Record<string, string> = {
    zh: '用中文回答。',
    en: 'Answer in English.',
    ja: '日本語で答えてください。'
  };

  const prompt = `你是一位专业的健康顾问。请分析用户过去7天的综合健康数据，给出个性化建议。

${langInstructions[lang] || langInstructions.zh}

**用户目标**: ${goal ? goal.goal_type : '未设置'} (${goal?.profile?.sex === 'male' ? '男' : '女'}, ${goal?.profile?.age || '--'}岁, ${goal?.profile?.height || '--'}cm)
${goal ? `**每日目标**: ${goal.targets.kcal}kcal, P${goal.targets.protein_g}g, C${goal.targets.carbs_g}g, F${goal.targets.fat_g}g` : ''}

**饮食数据** (${meals.length}餐):
${meals.length > 0 ? meals.map(m => `- ${m.eaten_at.substring(5, 10)} ${m.meal_type}: ${m.totals.kcal}kcal, P${m.totals.protein_g || 0}g`).join('\n') : '无记录'}

**运动数据**:
${activities.length > 0 ? activities.map(a => `- ${a.day}: ${a.exercise_kcal}kcal消耗, ${a.steps}步, ${a.active_minutes}分钟`).join('\n') : '无运动记录'}

**体重变化**:
${weights.length > 0 ? weights.map(w => `- ${w.date.substring(0, 10)}: ${w.weight_kg}kg${w.body_fat_pct ? ` (体脂${w.body_fat_pct}%)` : ''}`).join('\n') : '无体重记录'}

**补剂服用情况**:
${supplementCompliance.length > 0 ? supplementCompliance.map(s => `- ${s.name}: ${s.days_taken}/7天 (${s.compliance_pct}%)`).join('\n') : '未设置补剂'}

请综合分析并返回JSON格式:
{
  "overall_score": 1-100,
  "diet_analysis": {
    "score": 1-100,
    "avg_daily_kcal": 数字,
    "protein_adequacy": "足够|不足|过量",
    "issues": ["问题1", "问题2"]
  },
  "exercise_analysis": {
    "score": 1-100,
    "avg_daily_steps": 数字,
    "total_active_minutes": 数字,
    "assessment": "评价"
  },
  "weight_analysis": {
    "trend": "上升|下降|稳定|无数据",
    "change_kg": 数字或null,
    "assessment": "评价"
  },
  "supplement_compliance": {
    "overall_pct": 数字,
    "missed_supplements": ["名称"]
  },
  "correlations": ["发现的关联，如：运动多的日子吃得也多"],
  "recommendations": ["具体可行的建议1", "建议2", "建议3"],
  "focus_this_week": "本周最应该关注的一件事"
}

只返回JSON，不要markdown代码块或其他文字。`;

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (AI_GATEWAY_KEY) {
      headers['Authorization'] = `Bearer ${AI_GATEWAY_KEY}`;
    }

    const response = await fetch(`${AI_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1500
      })
    });

    if (!response.ok) {
      return c.json({ success: false, error: 'AI service unavailable' }, 500);
    }

    const aiResult = await response.json() as any;
    const content = aiResult.choices?.[0]?.message?.content || '';

    let insights;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      insights = JSON.parse(jsonMatch[1].trim());
    } catch {
      insights = { overall_score: 50, focus_this_week: content.substring(0, 200), recommendations: [] };
    }

    return c.json({
      success: true,
      period: { start: weekAgoStr, end: today.toISOString().substring(0, 10) },
      data_summary: {
        meals_count: meals.length,
        exercise_days: activities.length,
        weight_records: weights.length,
        supplements_tracked: supplements.length
      },
      insights
    });

  } catch (e: any) {
    return c.json({ success: false, error: e.message }, 500);
  }
});

// ============== AI Analyze API ==============

app.post('/api/analyze', async (c) => {
  const AI_GATEWAY_URL = c.env.AI_GATEWAY_URL || 'https://edge-ai-gateway.duizhan.app';
  const AI_GATEWAY_KEY = c.env.AI_GATEWAY_KEY;

  try {
    const formData = await c.req.formData();
    const imageFile = (formData.get('image') || formData.get('file')) as File | null;
    const lang = (formData.get('lang') as string) || 'zh';

    if (!imageFile) {
      return c.json({ error: 'No image provided' }, 400);
    }

    const arrayBuffer = await imageFile.arrayBuffer();
    // 安全的 base64 编码（支持大图片）
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    const base64Image = btoa(binary);
    const mimeType = imageFile.type || 'image/jpeg';

    const langInstructions: Record<string, string> = {
      zh: '所有食物名称必须使用中文（简体）。即使包装上是日文或英文，也要翻译成中文。',
      en: 'All food names MUST be in English. Translate any Japanese or Chinese names.',
      ja: 'すべての食品名は日本語で記載してください。'
    };
    const langHint = langInstructions[lang] || langInstructions.zh;

    const prompt = `你是一个专业的食物识别和营养分析助手，拥有丰富的中餐、日料、西餐营养知识。

**语言要求**: ${langHint}

**识别要求**:
1. 仔细识别图片中**所有可见的食物**，包括配菜、酱料、饮料
2. 如果是套餐/便当，分别识别每个组成部分
3. 估算每种食物的重量（参考常见份量：一碗米饭约150-200g，一份肉约100-150g）
4. 提供每100g的营养数据

**营养参考数据**:
- 米饭(熟) 100g: 116kcal, 2.6g蛋白质, 25.9g碳水, 0.3g脂肪
- 鸡胸肉 100g: 165kcal, 31g蛋白质, 0g碳水, 3.6g脂肪
- 红烧肉 100g: 500kcal, 15g蛋白质, 5g碳水, 45g脂肪
- 清蒸鱼 100g: 110kcal, 20g蛋白质, 0g碳水, 3g脂肪
- 炒青菜 100g: 50kcal, 2g蛋白质, 5g碳水, 3g脂肪
- 拉面(带汤) 100g: 89kcal, 5g蛋白质, 13g碳水, 2g脂肪
- 寿司(握寿司) 100g: 150kcal, 6g蛋白质, 22g碳水, 4g脂肪
- 生鱼片 100g: 127kcal, 26g蛋白质, 0g碳水, 2g脂肪
- 天妇罗 100g: 200kcal, 5g蛋白质, 20g碳水, 11g脂肪
- 饺子 100g: 220kcal, 8g蛋白质, 25g碳水, 10g脂肪
- 面包 100g: 265kcal, 9g蛋白质, 49g碳水, 3g脂肪
- 牛排 100g: 271kcal, 26g蛋白质, 0g碳水, 18g脂肪
- 沙拉(无酱) 100g: 20kcal, 1g蛋白质, 4g碳水, 0.2g脂肪

返回严格JSON格式:
{
  "foods": [
    {
      "name": "食物名称",
      "weight_g": 估算重量(数字),
      "confidence": 置信度0-1,
      "cooking_method": "烹饪方式(如:清蒸/红烧/油炸/生食)",
      "nutrition_per_100g": {
        "kcal": 热量,
        "protein_g": 蛋白质,
        "carbs_g": 碳水,
        "fat_g": 脂肪
      }
    }
  ],
  "meal_type": "breakfast/lunch/dinner/snack",
  "overall_confidence": 整体置信度0-1,
  "notes": "可选的备注"
}

只返回JSON，不要markdown代码块或其他文字。`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (AI_GATEWAY_KEY) {
      headers['Authorization'] = `Bearer ${AI_GATEWAY_KEY}`;
    }

    const response = await fetch(`${AI_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ]
        }],
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI Gateway error:', errorText);
      return c.json({ error: 'AI service error', details: errorText }, 500);
    }

    const aiResult = await response.json() as any;
    const content = aiResult.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      console.error('Failed to parse AI response:', content);
      return c.json({ error: 'Failed to parse AI response', raw: content }, 500);
    }

    const items = (parsed.foods || []).map((food: any) => {
      const weight = food.weight_g || 100;
      const n = food.nutrition_per_100g || {};
      return {
        name: food.name,
        weight_g: weight,
        confidence: food.confidence || 0.8,
        kcal: Math.round((n.kcal || 0) * weight / 100),
        protein_g: Math.round((n.protein_g || 0) * weight / 100 * 10) / 10,
        carbs_g: Math.round((n.carbs_g || 0) * weight / 100 * 10) / 10,
        fat_g: Math.round((n.fat_g || 0) * weight / 100 * 10) / 10,
      };
    });

    const totals = items.reduce((acc: any, item: any) => ({
      kcal: acc.kcal + item.kcal,
      protein_g: Math.round((acc.protein_g + item.protein_g) * 10) / 10,
      carbs_g: Math.round((acc.carbs_g + item.carbs_g) * 10) / 10,
      fat_g: Math.round((acc.fat_g + item.fat_g) * 10) / 10,
    }), { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });

    return c.json({
      ai: { foods: parsed.foods, meal_type: parsed.meal_type || 'unknown', overall_confidence: parsed.overall_confidence || 0.8 },
      meal_preview: { items, totals }
    });

  } catch (error: any) {
    console.error('Analyze error:', error);
    return c.json({ error: 'Analysis failed', message: error.message }, 500);
  }
});

// Lookup nutrition by food name
app.post('/api/nutrition/lookup', async (c) => {
  const AI_GATEWAY_URL = c.env.AI_GATEWAY_URL || 'https://edge-ai-gateway.duizhan.app';
  const AI_GATEWAY_KEY = c.env.AI_GATEWAY_KEY;

  try {
    const body = await c.req.json() as { name: string; lang?: string };
    const { name, lang = 'zh' } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return c.json({ error: 'Food name is required' }, 400);
    }

    const foodName = name.trim().slice(0, 100);

    const langInstructions: Record<string, string> = {
      zh: '用中文回复',
      en: 'Reply in English',
      ja: '日本語で回答してください'
    };
    const langHint = langInstructions[lang] || langInstructions.zh;

    const prompt = `你是营养学专家。请提供 "${foodName}" 每100克的营养数据。${langHint}

返回严格JSON格式:
{
  "name": "${foodName}",
  "kcal": 热量(数字),
  "protein_g": 蛋白质克数(数字),
  "carbs_g": 碳水克数(数字),
  "fat_g": 脂肪克数(数字)
}

只返回JSON，不要其他文字。如果不确定，使用合理估算值。`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (AI_GATEWAY_KEY) {
      headers['Authorization'] = `Bearer ${AI_GATEWAY_KEY}`;
    }

    const response = await fetch(`${AI_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI Gateway error:', errorText);
      return c.json({ error: 'AI service error' }, 500);
    }

    const aiResult = await response.json() as any;
    const content = aiResult.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      console.error('Failed to parse AI response:', content);
      return c.json({ error: 'Failed to parse response', raw: content }, 500);
    }

    return c.json({
      name: parsed.name || foodName,
      per100: {
        kcal: Number(parsed.kcal) || 100,
        protein_g: Number(parsed.protein_g) || 5,
        carbs_g: Number(parsed.carbs_g) || 15,
        fat_g: Number(parsed.fat_g) || 5
      }
    });

  } catch (error: any) {
    console.error('Nutrition lookup error:', error);
    return c.json({ error: 'Lookup failed', message: error.message }, 500);
  }
});

// Exercise screenshot recognition
app.post('/api/analyze-exercise', async (c) => {
  const AI_GATEWAY_URL = c.env.AI_GATEWAY_URL || 'https://edge-ai-gateway.duizhan.app';
  const AI_GATEWAY_KEY = c.env.AI_GATEWAY_KEY;

  try {
    const formData = await c.req.formData();
    const imageFile = (formData.get('image') || formData.get('file')) as File | null;
    const lang = (formData.get('lang') as string) || 'zh';

    if (!imageFile) {
      return c.json({ error: 'No image provided' }, 400);
    }

    const arrayBuffer = await imageFile.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    const base64Image = btoa(binary);
    const mimeType = imageFile.type || 'image/jpeg';

    const langInstructions: Record<string, string> = {
      zh: '所有输出使用中文。',
      en: 'Output in English.',
      ja: '日本語で出力してください。'
    };
    const langHint = langInstructions[lang] || langInstructions.zh;

    const prompt = `你是一个运动数据识别专家。请分析这张截图，识别其中的运动/健身数据。

**语言要求**: ${langHint}

**识别要求**:
1. 这可能是 Apple Watch 健身记录、Apple 健康、Strava、Keep、Nike Run Club 等运动 App 的截图
2. 识别以下关键数据（如果图中有的话）：
   - 运动消耗的卡路里（主动消耗/运动消耗，不是静息代谢）
   - 步数
   - 运动时长（活动时间/运动时间/锻炼时长）
   - 运动类型（跑步、骑行、游泳、力量训练等）
   - 运动距离
3. **Apple Watch/健身 App 截图的重要识别规则**：
   - **Activity Rings（活动圆环）区域的 Move 数值 = 今日总消耗卡路里（红色环）—— 这是我们要的！**
   - Sessions/体能训练列表里显示的是**单项运动**的消耗，不是总数
   - 例如：如果 Activity Rings 显示 "Move 1,624/500 KCAL"，而下面 Sessions 显示某个运动 "715 KCAL"，应该返回 1624，不是 715
   - 绿色 Exercise 环 = 运动分钟数
   - 蓝色 Stand 环 = 站立小时数
4. **优先级**：Activity Rings 的 Move 数值 > Sessions 里单项运动的数值

返回严格JSON格式:
{
  "exercise_kcal": 运动消耗卡路里(数字，如无法识别返回0),
  "steps": 步数(数字，如无法识别返回0),
  "active_minutes": 运动分钟数(数字，如无法识别返回0),
  "exercise_type": "运动类型(如:跑步/骑行/综合/未知)",
  "distance_km": 运动距离公里数(数字，如无法识别返回null),
  "confidence": 识别置信度0-1,
  "source_app": "识别出的App名称(如:Apple Watch/Strava/Keep/未知)",
  "notes": "可选的备注，比如无法识别某些数据的原因",
  "summary": "用一句话总结识别到的内容，让用户确认。例如：'Apple Watch 显示今日总消耗 1,624 kcal，运动 183 分钟，包含力量训练、跑步 4.59km、步行 3km'"
}

只返回JSON，不要markdown代码块或其他文字。`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (AI_GATEWAY_KEY) {
      headers['Authorization'] = `Bearer ${AI_GATEWAY_KEY}`;
    }

    const response = await fetch(`${AI_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ]
        }],
        max_tokens: 1000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI Gateway error:', errorText);
      return c.json({ error: 'AI service error', details: errorText }, 500);
    }

    const aiResult = await response.json() as any;
    const content = aiResult.choices?.[0]?.message?.content || '';

    let parsed;
    try {
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      console.error('Failed to parse AI response:', content);
      return c.json({ error: 'Failed to parse AI response', raw: content }, 500);
    }

    return c.json({
      exercise_kcal: Math.round(parsed.exercise_kcal || 0),
      steps: Math.round(parsed.steps || 0),
      active_minutes: Math.round(parsed.active_minutes || 0),
      exercise_type: parsed.exercise_type || 'unknown',
      distance_km: parsed.distance_km || null,
      confidence: parsed.confidence || 0.8,
      source_app: parsed.source_app || 'unknown',
      notes: parsed.notes || null,
      summary: parsed.summary || null
    });

  } catch (error: any) {
    console.error('Exercise analyze error:', error);
    return c.json({ error: 'Analysis failed', message: error.message }, 500);
  }
});

// Serve static files
app.get('/*', serveStatic({ root: './' }));

app.notFound((c) => {
  return c.redirect('/index.html');
});

export default app;