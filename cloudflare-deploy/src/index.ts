/**
 * FoodSnap API - Cloudflare Workers
 * AI食物识别 + 饮食管理后端
 * 包含完整的 Auth、Sync、Activity、Insights API
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/cloudflare-workers';
import * as jose from 'jose';

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
  return c.json({ ok: true, time: isoNow() });
});

// Google OAuth
app.post('/api/auth/google', async (c) => {
  const googleClientId = c.env.GOOGLE_CLIENT_ID;
  if (!googleClientId) {
    return c.json({ error: 'Google OAuth not configured' }, 500);
  }

  const body = await c.req.json();
  const idToken = body.id_token || body.credential;
  
  if (!idToken) {
    return c.json({ error: 'id_token is required' }, 400);
  }

  const googleUser = await verifyGoogleToken(idToken, googleClientId);
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
    token,
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

  if (!meal_type || !items || !totals) {
    return c.json({ error: 'meal_type, items, and totals are required' }, 400);
  }

  if (!['breakfast', 'lunch', 'dinner', 'snack'].includes(meal_type)) {
    return c.json({ error: 'meal_type must be breakfast, lunch, dinner, or snack' }, 400);
  }

  const now = isoNow();
  const eatenAt = eaten_at || now;

  const result = await c.env.DB.prepare(`
    INSERT INTO meals (user_id, meal_type, eaten_at, items, totals, image_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(userId, meal_type, eatenAt, JSON.stringify(items), JSON.stringify(totals), image_path || null, now, now).run();

  return c.json({
    meal: {
      id: result.meta.last_row_id,
      user_id: userId, meal_type, eaten_at: eatenAt, items, totals,
      image_path: image_path || null, created_at: now, updated_at: now
    }
  });
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
        model: 'claude-sonnet-4-20250514',
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

// ============== AI Analyze API ==============

app.post('/api/analyze', async (c) => {
  const AI_GATEWAY_URL = c.env.AI_GATEWAY_URL || 'https://edge-ai-gateway.duizhan.app';
  const AI_GATEWAY_KEY = c.env.AI_GATEWAY_KEY;

  try {
    const formData = await c.req.formData();
    const imageFile = formData.get('image') as File | null;
    const lang = (formData.get('lang') as string) || 'zh';

    if (!imageFile) {
      return c.json({ error: 'No image provided' }, 400);
    }

    const arrayBuffer = await imageFile.arrayBuffer();
    const base64Image = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
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
        model: 'claude-sonnet-4-20250514',
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

// Serve static files
app.get('/*', serveStatic({ root: './' }));

app.notFound((c) => {
  return c.redirect('/index.html');
});

export default app;