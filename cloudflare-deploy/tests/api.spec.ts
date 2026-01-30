import { test, expect } from '@playwright/test';

const BASE_URL = process.env.TEST_URL || 'https://foodsnap.duku.app';
const TEST_USER = 'e2e-test-user';

test.describe('FoodSnap API E2E Tests', () => {
  
  test.describe('Health & Config', () => {
    test('health check returns ok', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/health`);
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(data.time).toBeDefined();
    });

    test('config returns Google client ID', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/config`);
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.googleClientId).toBeDefined();
    });
  });

  test.describe('User Goals', () => {
    test('can set and get user goal', async ({ request }) => {
      // Set goal
      const setResponse = await request.post(`${BASE_URL}/api/user/goal`, {
        headers: { 'X-User-Id': TEST_USER, 'Content-Type': 'application/json' },
        data: {
          goal_type: 'maintain',
          profile: { weight: 70, height: 175, age: 30, sex: 'male', activity: 1.375 }
        }
      });
      expect(setResponse.ok()).toBeTruthy();
      const setData = await setResponse.json();
      expect(setData.goal.goal_type).toBe('maintain');
      expect(setData.goal.targets.kcal).toBeGreaterThan(0);

      // Get goal
      const getResponse = await request.get(`${BASE_URL}/api/user/goal`, {
        headers: { 'X-User-Id': TEST_USER }
      });
      expect(getResponse.ok()).toBeTruthy();
      const getData = await getResponse.json();
      expect(getData.goal.goal_type).toBe('maintain');
    });
  });

  test.describe('Meals CRUD', () => {
    let mealId: number;

    test('can create a meal', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/meals`, {
        headers: { 'X-User-Id': TEST_USER, 'Content-Type': 'application/json' },
        data: {
          meal_type: 'lunch',
          items: [{ name: 'E2E Test Rice', weight_g: 200 }],
          totals: { kcal: 230, protein_g: 5, carbs_g: 50, fat_g: 0.5 }
        }
      });
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.meal.meal_type).toBe('lunch');
      expect(data.meal.id).toBeDefined();
      mealId = data.meal.id;
    });

    test('can list meals for today', async ({ request }) => {
      const today = new Date().toISOString().substring(0, 10);
      const response = await request.get(`${BASE_URL}/api/meals?day=${today}`, {
        headers: { 'X-User-Id': TEST_USER }
      });
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.day).toBe(today);
      expect(Array.isArray(data.meals)).toBeTruthy();
    });

    test('can sync all meals', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/meals/sync?limit=100`, {
        headers: { 'X-User-Id': TEST_USER }
      });
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(Array.isArray(data.meals)).toBeTruthy();
      expect(data.count).toBeGreaterThanOrEqual(0);
    });

    test('can delete a meal', async ({ request }) => {
      // First create a meal to delete
      const createResponse = await request.post(`${BASE_URL}/api/meals`, {
        headers: { 'X-User-Id': TEST_USER, 'Content-Type': 'application/json' },
        data: {
          meal_type: 'snack',
          items: [{ name: 'E2E Delete Test', weight_g: 50 }],
          totals: { kcal: 50, protein_g: 1, carbs_g: 10, fat_g: 0 }
        }
      });
      const createData = await createResponse.json();
      const idToDelete = createData.meal.id;

      // Delete it
      const deleteResponse = await request.delete(`${BASE_URL}/api/meals/${idToDelete}`, {
        headers: { 'X-User-Id': TEST_USER }
      });
      expect(deleteResponse.ok()).toBeTruthy();
      const deleteData = await deleteResponse.json();
      expect(deleteData.success).toBe(true);
    });
  });

  test.describe('Activity', () => {
    test('can set and get activity', async ({ request }) => {
      const today = new Date().toISOString().substring(0, 10);
      
      // Set activity
      const setResponse = await request.post(`${BASE_URL}/api/activity`, {
        headers: { 'X-User-Id': TEST_USER, 'Content-Type': 'application/json' },
        data: {
          day: today,
          exercise_kcal: 300,
          steps: 8000,
          active_minutes: 45,
          source: 'e2e-test'
        }
      });
      expect(setResponse.ok()).toBeTruthy();

      // Get activity
      const getResponse = await request.get(`${BASE_URL}/api/activity?day=${today}`, {
        headers: { 'X-User-Id': TEST_USER }
      });
      expect(getResponse.ok()).toBeTruthy();
      const data = await getResponse.json();
      expect(data.activity.exercise_kcal).toBe(300);
      expect(data.activity.steps).toBe(8000);
    });
  });

  test.describe('Stats', () => {
    test('daily stats returns data', async ({ request }) => {
      const today = new Date().toISOString().substring(0, 10);
      const response = await request.get(`${BASE_URL}/api/stats/daily?day=${today}`, {
        headers: { 'X-User-Id': TEST_USER }
      });
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.day).toBe(today);
      expect(data.totals).toBeDefined();
    });

    test('weekly stats returns 7 days', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/stats/weekly`, {
        headers: { 'X-User-Id': TEST_USER }
      });
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.days.length).toBe(7);
    });

    test('recommendations endpoint works', async ({ request }) => {
      const response = await request.get(`${BASE_URL}/api/recommendations`, {
        headers: { 'X-User-Id': TEST_USER }
      });
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.recommendation).toBeDefined();
    });
  });

  test.describe('AI Analyze', () => {
    test('analyze returns error without image', async ({ request }) => {
      const response = await request.post(`${BASE_URL}/api/analyze`, {
        headers: { 'X-User-Id': TEST_USER },
        multipart: { lang: 'zh' }
      });
      expect(response.status()).toBe(400);
      const data = await response.json();
      expect(data.error).toContain('image');
    });

    // Note: Full image analysis test requires a real image and may incur AI costs
    // Uncomment below for full integration test
    /*
    test('analyze with real image returns food data', async ({ request }) => {
      const imageBuffer = await fetch('https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=400')
        .then(r => r.arrayBuffer());
      
      const response = await request.post(`${BASE_URL}/api/analyze`, {
        headers: { 'X-User-Id': TEST_USER },
        multipart: {
          file: { name: 'food.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(imageBuffer) },
          lang: 'zh'
        }
      });
      expect(response.ok()).toBeTruthy();
      const data = await response.json();
      expect(data.meal_preview.items.length).toBeGreaterThan(0);
      expect(data.meal_preview.totals.kcal).toBeGreaterThan(0);
    }, 60000);
    */
  });
});

test.describe('Frontend E2E', () => {
  test('homepage loads correctly', async ({ page }) => {
    await page.goto(BASE_URL);
    await expect(page).toHaveTitle(/FoodSnap|拍照识别/);
    await expect(page.locator('.brand')).toContainText('FoodSnap');
  });

  test('can switch language', async ({ page }) => {
    await page.goto(BASE_URL);
    const langBtn = page.locator('#langToggle');
    await expect(langBtn).toBeVisible();
    
    // Click to switch language
    await langBtn.click();
    // Should toggle between EN/中文
  });

  test('dashboard page loads', async ({ page }) => {
    await page.goto(`${BASE_URL}/dashboard.html`);
    await expect(page.locator('body')).toBeVisible();
  });
});
