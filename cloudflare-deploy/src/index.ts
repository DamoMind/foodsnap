/**
 * FoodSnap API - Cloudflare Workers
 * AI食物识别 + 饮食管理后端
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from 'hono/cloudflare-workers';

// Types
interface Env {
  DB: D1Database;
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_KEY?: string;
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

// App
const app = new Hono<{ Bindings: Env }>();

// CORS
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'X-User-Id', 'Authorization'],
}));

// Helpers
function getUserId(c: any): string {
  return c.req.header('X-User-Id') || 'demo';
}

function isoNow(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function todayIso(): string {
  return new Date().toISOString().substring(0, 10);
}

// Nutrition calculation helpers
function computeTargets(goalType: string, profile: Record<string, any>): Record<string, any> {
  const weight = Number(profile.weight) || 70;
  const height = Number(profile.height) || 175;
  const age = Number(profile.age) || 30;
  const sex = profile.sex || 'male';
  const activity = Number(profile.activity) || 1.375;

  // Mifflin-St Jeor BMR
  const s = sex === 'male' ? 5 : -161;
  const bmr = 10 * weight + 6.25 * height - 5 * age + s;
  let tdee = bmr * activity;

  // Adjust based on goal
  let kcal = tdee;
  if (goalType === 'cut' || goalType === 'lose_weight' || goalType === '减脂') {
    kcal = tdee * 0.85;
  } else if (goalType === 'bulk' || goalType === 'gain_muscle' || goalType === '增肌') {
    kcal = tdee * 1.10;
  }

  // Macro ratios
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
    kcal: 0,
    protein_g: 0,
    carbs_g: 0,
    fat_g: 0,
    fiber_g: 0,
    sugar_g: 0,
    sodium_mg: 0
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
    return {
      summary: '请先设置你的饮食目标',
      actions: []
    };
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

  return {
    summary: '根据你今日摄入与目标差值，给出下一餐可执行建议。',
    diff_to_target: diff,
    actions
  };
}

// ============== API Routes ==============

// Health check
app.get('/api/health', (c) => {
  return c.json({ ok: true, time: isoNow() });
});

// Set user goal
app.post('/api/user/goal', async (c) => {
  const userId = getUserId(c);
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
  `).bind(
    userId,
    goal_type,
    JSON.stringify(profile),
    JSON.stringify(targets),
    now
  ).run();

  return c.json({
    goal: {
      user_id: userId,
      goal_type,
      profile,
      targets,
      updated_at: now
    }
  });
});

// Get user goal
app.get('/api/user/goal', async (c) => {
  const userId = getUserId(c);

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

// Create meal
app.post('/api/meals', async (c) => {
  const userId = getUserId(c);
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
  `).bind(
    userId,
    meal_type,
    eatenAt,
    JSON.stringify(items),
    JSON.stringify(totals),
    image_path || null,
    now,
    now
  ).run();

  return c.json({
    meal: {
      id: result.meta.last_row_id,
      user_id: userId,
      meal_type,
      eaten_at: eatenAt,
      items,
      totals,
      image_path: image_path || null,
      created_at: now,
      updated_at: now
    }
  });
});

// Get meals by date
app.get('/api/meals', async (c) => {
  const userId = getUserId(c);
  const day = c.req.query('day') || todayIso();

  const results = await c.env.DB.prepare(`
    SELECT * FROM meals
    WHERE user_id = ? AND date(eaten_at) = ?
    ORDER BY eaten_at ASC
  `).bind(userId, day).all();

  const meals = results.results.map((row: any) => ({
    id: row.id,
    user_id: row.user_id,
    meal_type: row.meal_type,
    eaten_at: row.eaten_at,
    items: JSON.parse(row.items),
    totals: JSON.parse(row.totals),
    image_path: row.image_path,
    created_at: row.created_at,
    updated_at: row.updated_at
  }));

  return c.json({ day, meals });
});

// Daily stats
app.get('/api/stats/daily', async (c) => {
  const userId = getUserId(c);
  const day = c.req.query('day') || todayIso();

  // Get meals
  const mealsResult = await c.env.DB.prepare(`
    SELECT * FROM meals
    WHERE user_id = ? AND date(eaten_at) = ?
  `).bind(userId, day).all();

  const meals = mealsResult.results.map((row: any) => ({
    totals: JSON.parse(row.totals)
  })) as Meal[];

  // Get goal
  const goalResult = await c.env.DB.prepare(
    'SELECT * FROM user_goals WHERE user_id = ?'
  ).bind(userId).first();

  const goal = goalResult ? {
    user_id: goalResult.user_id,
    goal_type: goalResult.goal_type,
    profile: JSON.parse(goalResult.profile as string),
    targets: JSON.parse(goalResult.targets as string),
    updated_at: goalResult.updated_at
  } : null;

  const totals = aggregateTotals(meals);

  return c.json({
    day,
    totals,
    goal,
    meals_count: meals.length
  });
});

// Weekly stats
app.get('/api/stats/weekly', async (c) => {
  const userId = getUserId(c);

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
      SELECT * FROM meals
      WHERE user_id = ? AND date(eaten_at) = ?
    `).bind(userId, dayStr).all();

    const meals = mealsResult.results.map((row: any) => ({
      totals: JSON.parse(row.totals)
    })) as Meal[];

    days.push({
      day: dayStr,
      totals: aggregateTotals(meals),
      meals_count: meals.length
    });
  }

  return c.json({
    week_start: weekStart.toISOString().substring(0, 10),
    days
  });
});

// Recommendations
app.get('/api/recommendations', async (c) => {
  const userId = getUserId(c);
  const day = todayIso();

  // Get meals
  const mealsResult = await c.env.DB.prepare(`
    SELECT * FROM meals
    WHERE user_id = ? AND date(eaten_at) = ?
  `).bind(userId, day).all();

  const meals = mealsResult.results.map((row: any) => ({
    totals: JSON.parse(row.totals)
  })) as Meal[];

  // Get goal
  const goalResult = await c.env.DB.prepare(
    'SELECT * FROM user_goals WHERE user_id = ?'
  ).bind(userId).first();

  const goal = goalResult ? {
    user_id: goalResult.user_id as string,
    goal_type: goalResult.goal_type as string,
    profile: JSON.parse(goalResult.profile as string),
    targets: JSON.parse(goalResult.targets as string),
    updated_at: goalResult.updated_at as string
  } : null;

  const totals = aggregateTotals(meals);
  const recommendation = recommendNextMeal(goal, totals);

  return c.json({
    day,
    today_totals: totals,
    goal,
    recommendation
  });
});

// AI Analyze endpoint - uses edge-ai-gateway
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

    // Convert image to base64
    const arrayBuffer = await imageFile.arrayBuffer();
    const base64Image = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    const mimeType = imageFile.type || 'image/jpeg';

    // Build the prompt for food recognition
    const prompt = `你是一个专业的食物营养分析师。请仔细分析这张图片中的食物。

要求：
1. 识别图片中所有可见的食物
2. 估算每种食物的重量（克）
3. 计算每种食物的营养成分（每100g的热量、蛋白质、碳水、脂肪）
4. 所有食物名称使用${lang === 'zh' ? '中文' : lang === 'ja' ? '日语' : '英语'}

请以JSON格式返回，格式如下：
{
  "foods": [
    {
      "name": "食物名称",
      "weight_g": 估算重量,
      "confidence": 置信度0-1,
      "nutrition_per_100g": {
        "kcal": 热量,
        "protein_g": 蛋白质克,
        "carbs_g": 碳水克,
        "fat_g": 脂肪克
      }
    }
  ],
  "meal_type": "breakfast/lunch/dinner/snack",
  "overall_confidence": 整体置信度0-1
}

只返回JSON，不要其他文字。`;

    // Call edge-ai-gateway
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (AI_GATEWAY_KEY) {
      headers['Authorization'] = `Bearer ${AI_GATEWAY_KEY}`;
    }

    const response = await fetch(`${AI_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64Image}`
                }
              }
            ]
          }
        ],
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

    // Parse JSON from response
    let parsed;
    try {
      // Try to extract JSON from markdown code block if present
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, content];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch (e) {
      console.error('Failed to parse AI response:', content);
      return c.json({ error: 'Failed to parse AI response', raw: content }, 500);
    }

    // Calculate totals and build meal preview
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
      ai: {
        foods: parsed.foods,
        meal_type: parsed.meal_type || 'unknown',
        overall_confidence: parsed.overall_confidence || 0.8
      },
      meal_preview: {
        items,
        totals
      }
    });

  } catch (error: any) {
    console.error('Analyze error:', error);
    return c.json({ error: 'Analysis failed', message: error.message }, 500);
  }
});

// Serve static files (frontend)
app.get('/*', serveStatic({ root: './' }));

// 404 fallback to index.html for SPA
app.notFound((c) => {
  return c.redirect('/index.html');
});

export default app;
