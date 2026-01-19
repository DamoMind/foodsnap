/* Mobile H5 MVP: 拍照/上传 ->（模拟/可接入）识别 -> 份量校正 -> 保存到今日 -> 今日进度/建议 -> 周统计图
   数据存储：localStorage
   支持中英文切换
*/
(() => {
  // GA4 事件追踪
  function gtmEvent(eventName, params = {}) {
    if (typeof gtag === 'function') {
      gtag('event', eventName, params);
    }
  }

  // 深拷贝兼容函数（替代 structuredClone，支持旧版浏览器）
  function deepClone(obj) {
    if (typeof structuredClone === 'function') {
      try {
        return structuredClone(obj);
      } catch (e) {
        // fallback to JSON method
      }
    }
    return JSON.parse(JSON.stringify(obj));
  }

  const LS_KEYS = {
    profile: 'fs_profile_v1',
    logs: 'fs_logs_v1', // { 'YYYY-MM-DD': MealRecord[] }
    lang: 'fs_lang_v1',
    userId: 'fs_user_id'
  };

  // 获取或生成唯一用户ID（用于数据隔离）
  function getUserId() {
    let uid = localStorage.getItem(LS_KEYS.userId);
    if (!uid) {
      // 生成唯一ID: user_时间戳_随机字符串
      uid = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem(LS_KEYS.userId, uid);
    }
    return uid;
  }

  // ====== 国际化 i18n ======
  const i18n = {
    zh: {
      title: '拍照识别饮食 - 今日',
      today: '今日',
      todayProgress: '今日进度',
      goalSettings: '目标设置',
      calories: '热量',
      protein: '蛋白',
      carbs: '碳水',
      fat: '脂肪',
      advice: '建议',
      setGoalHint: '设置目标后，将给出可执行建议。',
      todayRecords: '今日记录',
      clearToday: '清空今日',
      noRecords: '还没有记录。点击下方"拍照记录"开始。',
      snapMeal: '拍照记录',
      photoUpload: '拍照/上传',
      openCamera: '打开相机',
      fromAlbum: '从相册选择',
      compressHint: '选择照片后将自动开始AI识别分析。',
      mealType: '餐次',
      breakfast: '早餐',
      lunch: '午餐',
      dinner: '晚餐',
      snack: '加餐',
      startAnalyze: '开始识别',
      analyzing: '识别中…（调用 AI 分析）',
      compressing: '正在处理图片…',
      close: '关闭',
      confirmResult: '识别确认',
      mealCalories: '本餐热量',
      foodList: '食物列表',
      addManual: '手动添加',
      adjustHint: '可拖动滑杆调整份量（g），营养会自动更新。',
      saveTo: '保存到',
      back: '返回',
      goalSettingsTitle: '目标设置（简化版）',
      goal: '目标',
      cut: '减脂',
      bulk: '增肌',
      maintain: '健康维持',
      sex: '性别',
      male: '男',
      female: '女',
      age: '年龄',
      height: '身高(cm)',
      weight: '体重(kg)',
      activityLevel: '活动水平',
      sedentary: '久坐',
      light: '轻度活动',
      moderate: '中度活动',
      active: '高强度',
      tdeeHint: '将用 Mifflin-St Jeor + 活动系数估算 TDEE，并按目标分配 P/C/F。',
      cancel: '取消',
      save: '保存',
      view: '查看',
      delete: '删除',
      confirmClear: '确定清空今日所有记录？',
      confirmDelete: '删除该餐记录？',
      inputFoodName: '输入食物名称（如：酸奶/牛肉/面包）',
      inputPortion: '输入份量(g)，如 150',
      confidence: '置信度',
      manual: '手动',
      recognized: '识别',
      per100g: '每100g',
      retake: '重拍'
    },
    en: {
      title: 'FoodSnap - Today',
      today: 'Today',
      todayProgress: "Today's Progress",
      goalSettings: 'Goal Settings',
      calories: 'Calories',
      protein: 'Protein',
      carbs: 'Carbs',
      fat: 'Fat',
      advice: 'Advice',
      setGoalHint: 'Set your goal to get personalized advice.',
      todayRecords: "Today's Records",
      clearToday: 'Clear Today',
      noRecords: 'No records yet. Tap "Snap Meal" below to start.',
      snapMeal: 'Snap Meal',
      photoUpload: 'Photo / Upload',
      openCamera: 'Open Camera',
      fromAlbum: 'From Album',
      compressHint: 'Select a photo to start automatic AI recognition.',
      mealType: 'Meal Type',
      breakfast: 'Breakfast',
      lunch: 'Lunch',
      dinner: 'Dinner',
      snack: 'Snack',
      startAnalyze: 'Analyze',
      analyzing: 'Analyzing... (AI powered)',
      compressing: 'Processing image...',
      close: 'Close',
      confirmResult: 'Confirm Result',
      mealCalories: 'Meal Calories',
      foodList: 'Food List',
      addManual: 'Add Manual',
      adjustHint: 'Drag slider to adjust portion (g), nutrition updates automatically.',
      saveTo: 'Save to',
      back: 'Back',
      goalSettingsTitle: 'Goal Settings',
      goal: 'Goal',
      cut: 'Fat Loss',
      bulk: 'Muscle Gain',
      maintain: 'Maintain',
      sex: 'Sex',
      male: 'Male',
      female: 'Female',
      age: 'Age',
      height: 'Height (cm)',
      weight: 'Weight (kg)',
      activityLevel: 'Activity Level',
      sedentary: 'Sedentary',
      light: 'Light',
      moderate: 'Moderate',
      active: 'Very Active',
      tdeeHint: 'Uses Mifflin-St Jeor formula to estimate TDEE and macro split.',
      cancel: 'Cancel',
      save: 'Save',
      view: 'View',
      delete: 'Delete',
      confirmClear: 'Clear all records for today?',
      confirmDelete: 'Delete this meal record?',
      inputFoodName: 'Enter food name (e.g., yogurt, beef, bread)',
      inputPortion: 'Enter portion (g), e.g. 150',
      confidence: 'Confidence',
      manual: 'Manual',
      recognized: 'AI',
      per100g: 'per 100g',
      retake: 'Retake'
    }
  };

  let currentLang = localStorage.getItem(LS_KEYS.lang) || (navigator.language.startsWith('zh') ? 'zh' : 'en');

  function t(key) {
    return i18n[currentLang]?.[key] || i18n.en[key] || key;
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.dataset.i18n;
      if (el.tagName === 'TITLE') {
        document.title = t(key);
      } else if (el.tagName === 'OPTION') {
        el.textContent = t(key);
      } else {
        el.textContent = t(key);
      }
    });
    document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
    const langBtn = document.getElementById('langToggle');
    if (langBtn) langBtn.textContent = currentLang === 'zh' ? 'EN' : '中';
    // 动态更新重拍按钮文本
    const retakeBtn = document.getElementById('retakeBtn');
    if (retakeBtn) retakeBtn.textContent = t('retake');
  }

  function toggleLang() {
    currentLang = currentLang === 'zh' ? 'en' : 'zh';
    localStorage.setItem(LS_KEYS.lang, currentLang);
    applyI18n();
    gtmEvent('language_switch', { language: currentLang });
  }

  function getMealLabel(type) {
    const labels = {
      zh: { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' },
      en: { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack' }
    };
    return labels[currentLang]?.[type] || labels.en[type] || type;
  }

  const MEAL_LABEL = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

  // 简易营养库（每100g）
  const FOOD_DB = [
    { id: 'rice', name: '米饭', kcal: 116, p: 2.6, c: 25.9, f: 0.3, aliases: ['白米饭', '米饭'] },
    { id: 'chicken_breast', name: '鸡胸肉', kcal: 165, p: 31, c: 0, f: 3.6, aliases: ['鸡胸', '鸡胸肉'] },
    { id: 'egg', name: '鸡蛋', kcal: 143, p: 13, c: 1.1, f: 9.5, aliases: ['鸡蛋', '煮蛋', '蛋'] },
    { id: 'broccoli', name: '西兰花', kcal: 34, p: 2.8, c: 6.6, f: 0.4, aliases: ['西兰花', '花椰菜'] },
    { id: 'salmon', name: '三文鱼', kcal: 208, p: 20, c: 0, f: 13, aliases: ['三文鱼', '鲑鱼'] },
    { id: 'tofu', name: '豆腐', kcal: 76, p: 8, c: 1.9, f: 4.8, aliases: ['豆腐'] },
    { id: 'banana', name: '香蕉', kcal: 89, p: 1.1, c: 22.8, f: 0.3, aliases: ['香蕉'] },
    { id: 'oats', name: '燕麦', kcal: 389, p: 16.9, c: 66.3, f: 6.9, aliases: ['燕麦', '燕麦片'] },
    { id: 'milk', name: '牛奶', kcal: 60, p: 3.2, c: 4.7, f: 3.3, aliases: ['牛奶'] },
    { id: 'apple', name: '苹果', kcal: 52, p: 0.3, c: 13.8, f: 0.2, aliases: ['苹果'] },
    { id: 'noodles', name: '面条', kcal: 138, p: 4.5, c: 25.2, f: 1.1, aliases: ['面条', '拉面', '挂面'] }
  ];

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const round1 = (n) => Math.round(n * 10) / 10;
  const round0 = (n) => Math.round(n);

  // 智能默认餐次：根据当前时间自动选择
  function getSmartMealType() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 10) return 'breakfast';
    if (hour >= 10 && hour < 14) return 'lunch';
    if (hour >= 14 && hour < 17) return 'snack';
    if (hour >= 17 && hour < 21) return 'dinner';
    return 'snack'; // 深夜默认加餐
  }

  function todayKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // localStorage 可能已满，尝试清理旧图片后重试
      if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014) {
        console.warn('localStorage quota exceeded, cleaning old images...');
        cleanOldImages(value);
        try {
          localStorage.setItem(key, JSON.stringify(value));
        } catch (e2) {
          console.error('Save failed even after cleanup:', e2);
          throw e2;
        }
      } else {
        throw e;
      }
    }
  }

  // 清理旧记录中的图片数据以节省空间
  function cleanOldImages(logs) {
    if (!logs || typeof logs !== 'object') return;
    const today = todayKey();
    Object.keys(logs).forEach(day => {
      // 保留今天的图片，清理7天前的
      const dayDate = new Date(day);
      const todayDate = new Date(today);
      const diffDays = (todayDate - dayDate) / (1000 * 60 * 60 * 24);
      if (diffDays > 7 && Array.isArray(logs[day])) {
        logs[day].forEach(meal => {
          if (meal.imageDataUrl) {
            meal.imageDataUrl = null; // 清除旧图片
          }
        });
      }
    });
  }

  function defaultProfile() {
    return {
      goalType: 'maintain',
      sex: 'male',
      age: 28,
      height: 175,
      weight: 70,
      activity: 1.375,
      goals: { kcal: 2000, p: 120, c: 220, f: 60 }
    };
  }

  function calcGoals(profile) {
    // Mifflin-St Jeor BMR
    const w = Number(profile.weight);
    const h = Number(profile.height);
    const a = Number(profile.age);
    const s = profile.sex === 'male' ? 5 : -161;
    const bmr = 10 * w + 6.25 * h - 5 * a + s;
    const tdee = bmr * Number(profile.activity || 1.2);

    let kcal = tdee;
    if (profile.goalType === 'cut') kcal = tdee * 0.85;
    if (profile.goalType === 'bulk') kcal = tdee * 1.10;

    // 宏量比例（简化）
    // cut: P 30% C 40% F 30%
    // bulk: P 25% C 50% F 25%
    // maintain: P 25% C 45% F 30%
    let ratio = { p: 0.25, c: 0.45, f: 0.30 };
    if (profile.goalType === 'cut') ratio = { p: 0.30, c: 0.40, f: 0.30 };
    if (profile.goalType === 'bulk') ratio = { p: 0.25, c: 0.50, f: 0.25 };

    const p = (kcal * ratio.p) / 4;
    const c = (kcal * ratio.c) / 4;
    const f = (kcal * ratio.f) / 9;

    return {
      kcal: round0(kcal),
      p: round0(p),
      c: round0(c),
      f: round0(f)
    };
  }

  function sumMealItems(items) {
    return items.reduce(
      (acc, it) => {
        acc.kcal += it.kcal;
        acc.p += it.p;
        acc.c += it.c;
        acc.f += it.f;
        return acc;
      },
      { kcal: 0, p: 0, c: 0, f: 0 }
    );
  }

  function sumDay(records) {
    return records.reduce(
      (acc, r) => {
        acc.kcal += r.summary.kcal;
        acc.p += r.summary.p;
        acc.c += r.summary.c;
        acc.f += r.summary.f;
        return acc;
      },
      { kcal: 0, p: 0, c: 0, f: 0 }
    );
  }

  function buildAdvice(profile, daySum) {
    const g = profile.goals;
    const dk = g.kcal - daySum.kcal;
    const dp = g.p - daySum.p;
    const dc = g.c - daySum.c;
    const df = g.f - daySum.f;

    // Bilingual advice templates
    if (dk < -150) {
      return currentLang === 'zh'
        ? `今天热量已超出约 ${round0(-dk)} kcal。下一餐建议：主食减半 + 选择清淡蛋白（鸡胸/豆腐/鱼）+ 多蔬菜。`
        : `Calories exceeded by ~${round0(-dk)} kcal today. Next meal: halve carbs, choose lean protein (chicken/tofu/fish), add more veggies.`;
    }
    if (dp > 20) {
      const proteinNeed = round0(Math.min(dp, 35));
      return currentLang === 'zh'
        ? `你今天还差蛋白约 ${round0(dp)}g。下一餐建议补 ${proteinNeed}g 蛋白：鸡胸 150g / 豆腐 300g / 无糖酸奶 400g。`
        : `You need ~${round0(dp)}g more protein today. Next meal: add ${proteinNeed}g protein - chicken 150g / tofu 300g / Greek yogurt 400g.`;
    }
    if (df < -15) {
      return currentLang === 'zh'
        ? `今天脂肪偏高（超出约 ${round0(-df)}g）。下一餐建议：少油烹饪，避免油炸/坚果/高油酱料，优先蒸煮。`
        : `Fat intake high (exceeded by ~${round0(-df)}g). Next meal: cook with less oil, avoid fried foods/nuts/heavy sauces, prefer steaming.`;
    }
    if (dc < -40 && dk > 150) {
      return currentLang === 'zh'
        ? `今天碳水偏低且热量还有余量。下一餐可补碳水约 ${round0(Math.min(-dc, 80))}g：米饭 150g / 面条 200g / 土豆 300g（搭配蛋白）。`
        : `Carbs low but calories available. Add ~${round0(Math.min(-dc, 80))}g carbs: rice 150g / noodles 200g / potato 300g (with protein).`;
    }
    return currentLang === 'zh'
      ? `整体进度不错。下一餐建议：一份优质蛋白 + 两份蔬菜 + 适量主食，尽量少油少糖。`
      : `Good progress! Next meal: 1 portion protein + 2 portions veggies + moderate carbs, low oil & sugar.`;
  }

  async function compressImage(file, { maxSide = 1280, quality = 0.72 } = {}) {
    const img = await fileToImage(file);
    const { w, h } = fitSize(img.width, img.height, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    return { blob, dataUrl, width: w, height: h };
  }

  function fitSize(w, h, maxSide) {
    const max = Math.max(w, h);
    if (max <= maxSide) return { w, h };
    const scale = maxSide / max;
    return { w: Math.round(w * scale), h: Math.round(h * scale) };
  }

  function fileToImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  // ====== AI 识别（调用后端 /api/analyze） ======
  async function analyzeFoodImage({ dataUrl, blob }) {
    // 如果有 blob，使用它；否则从 dataUrl 转换
    let imageBlob = blob;
    if (!imageBlob && dataUrl) {
      const resp = await fetch(dataUrl);
      imageBlob = await resp.blob();
    }

    const formData = new FormData();
    formData.append('file', imageBlob, 'food.jpg');

    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: {
          'X-User-Id': getUserId()
        },
        body: formData
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${response.status}`);
      }

      const result = await response.json();
      // result = { ai: {...}, meal_preview: { items, totals, warnings } }

      // 转换后端返回的 items 到前端格式
      const items = (result.meal_preview?.items || []).map((it) => {
        return {
          id: cryptoRandomId(),
          foodId: it.name,
          name: it.name,
          confidence: it.confidence || 0.85,
          weight_g: it.weight_g || 100,
          manual: false,
          kcal: round1(it.nutrition?.kcal || 0),
          p: round1(it.nutrition?.protein_g || 0),
          c: round1(it.nutrition?.carbs_g || 0),
          f: round1(it.nutrition?.fat_g || 0),
          per100: {
            kcal: round1((it.nutrition?.kcal || 0) / (it.weight_g || 100) * 100),
            p: round1((it.nutrition?.protein_g || 0) / (it.weight_g || 100) * 100),
            c: round1((it.nutrition?.carbs_g || 0) / (it.weight_g || 100) * 100),
            f: round1((it.nutrition?.fat_g || 0) / (it.weight_g || 100) * 100)
          }
        };
      });

      return {
        items,
        warnings: result.meal_preview?.warnings || []
      };
    } catch (err) {
      console.error('AI 识别失败:', err);
      // 降级到本地模拟
      return fallbackLocalAnalysis();
    }
  }

  // 本地模拟（API 不可用时的降级方案）
  function fallbackLocalAnalysis() {
    const candidates = [
      ['rice', 'chicken_breast', 'broccoli'],
      ['noodles', 'egg', 'broccoli'],
      ['salmon', 'rice', 'broccoli'],
      ['oats', 'milk', 'banana'],
      ['tofu', 'rice', 'broccoli'],
      ['apple', 'milk', 'oats']
    ];
    const pick = candidates[Math.floor(Math.random() * candidates.length)];

    const items = pick.map((id) => {
      const food = FOOD_DB.find((f) => f.id === id);
      const weight_g = defaultPortion(food.id);
      const conf = round1(0.72 + Math.random() * 0.22);
      return makeItemFromFood(food, weight_g, conf);
    });

    return {
      items,
      warnings: ['AI 服务暂不可用，显示的是模拟数据。请手动调整。']
    };
  }

  function defaultPortion(foodId) {
    const map = {
      rice: 160,
      chicken_breast: 140,
      broccoli: 120,
      egg: 60,
      noodles: 220,
      salmon: 120,
      tofu: 220,
      banana: 120,
      oats: 60,
      milk: 250,
      apple: 180
    };
    return map[foodId] || 150;
  }

  function makeItemFromFood(food, weight_g, confidence = 0.85) {
    const factor = weight_g / 100;
    return {
      id: cryptoRandomId(),
      foodId: food.id,
      name: food.name,
      confidence,
      weight_g,
      manual: false,
      kcal: round1(food.kcal * factor),
      p: round1(food.p * factor),
      c: round1(food.c * factor),
      f: round1(food.f * factor),
      per100: { kcal: food.kcal, p: food.p, c: food.c, f: food.f }
    };
  }

  function recalcItem(item) {
    const factor = item.weight_g / 100;
    item.kcal = round1(item.per100.kcal * factor);
    item.p = round1(item.per100.p * factor);
    item.c = round1(item.per100.c * factor);
    item.f = round1(item.per100.f * factor);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function cryptoRandomId() {
    if (crypto?.randomUUID) return crypto.randomUUID();
    return String(Date.now()) + '_' + Math.random().toString(16).slice(2);
  }

  // Toast notification
  function showToast(message, duration = 2000) {
    // Remove existing toast
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-notification';
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      bottom: 120px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(34, 197, 94, 0.95);
      color: #fff;
      padding: 12px 24px;
      border-radius: 24px;
      font-weight: 700;
      font-size: 14px;
      z-index: 9999;
      animation: toastIn 0.3s ease;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    `;
    document.body.appendChild(toast);

    // Add animation keyframes if not exists
    if (!document.getElementById('toast-styles')) {
      const style = document.createElement('style');
      style.id = 'toast-styles';
      style.textContent = `
        @keyframes toastIn {
          from { opacity: 0; transform: translateX(-50%) translateY(20px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        @keyframes toastOut {
          from { opacity: 1; transform: translateX(-50%) translateY(0); }
          to { opacity: 0; transform: translateX(-50%) translateY(-20px); }
        }
      `;
      document.head.appendChild(style);
    }

    setTimeout(() => {
      toast.style.animation = 'toastOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ====== UI helpers ======
  function $(sel) { return document.querySelector(sel); }
  function setSheetOpen(el, open) {
    el.setAttribute('aria-hidden', open ? 'false' : 'true');
    document.body.style.overflow = open ? 'hidden' : '';
  }

  // 高亮推荐/指定的餐次按钮
  function highlightSmartMealButton(mealTypeOverride) {
    const targetMeal = mealTypeOverride || getSmartMealType();
    $('#resultSheet').querySelectorAll('button[data-meal]').forEach(btn => {
      btn.classList.remove('btn--primary');
      if (btn.dataset.meal === targetMeal) {
        btn.classList.add('btn--primary');
      }
    });
  }

  // ====== App state ======
  const State = {
    profile: loadJSON(LS_KEYS.profile, null) || defaultProfile(),
    logs: loadJSON(LS_KEYS.logs, {}),
    capture: { dataUrl: null, blob: null, mealType: getSmartMealType() },
    pendingMeal: null, // { items, imageDataUrl, mealType }
    editingMealId: null // track if we're editing an existing meal
  };

  // Ensure goals exist
  if (!State.profile.goals) State.profile.goals = calcGoals(State.profile);

  // ====== Index init ======
  function initIndex() {
    const today = todayKey();

    // Apply i18n
    applyI18n();
    $('#todayLabel').textContent = `${t('today')} · ${today}`;

    // Language toggle
    const langBtn = $('#langToggle');
    if (langBtn) langBtn.addEventListener('click', () => { toggleLang(); renderIndex(); });

    // bind sheets close - with confirmation for result sheet
    document.body.addEventListener('click', (e) => {
      const t = e.target;
      if (t?.dataset?.close === '1') {
        const sheet = t.closest('.sheet');
        if (sheet) {
          // If closing result sheet with unsaved data, confirm first
          if (sheet.id === 'resultSheet' && State.pendingMeal && State.pendingMeal.items.length > 0) {
            const confirmMsg = currentLang === 'zh'
              ? '您有未保存的识别结果，确定要放弃吗？'
              : 'You have unsaved results. Are you sure you want to discard them?';
            if (!confirm(confirmMsg)) {
              return; // User cancelled, don't close
            }
            // User confirmed, clear pending state
            State.pendingMeal = null;
            State.editingMealId = null;
          }
          setSheetOpen(sheet, false);
        }
      }
    });

    // open capture
    $('#openCaptureBtn').addEventListener('click', () => {
      resetCaptureUI();
      setSheetOpen($('#captureSheet'), true);
    });

    // open profile
    $('#openProfileBtn').addEventListener('click', () => {
      fillProfileForm();
      setSheetOpen($('#profileSheet'), true);
    });

    // clear today
    $('#clearTodayBtn').addEventListener('click', () => {
      if (!confirm(t('confirmClear'))) return;
      try {
        const newLogs = { ...State.logs, [today]: [] };
        saveJSON(LS_KEYS.logs, newLogs);  // 先保存，失败会抛异常
        State.logs = newLogs;  // 保存成功后更新内存
        gtmEvent('clear_today');
        renderIndex();
      } catch (err) {
        console.error('Clear error:', err);
        showToast(currentLang === 'zh' ? '清空失败，请重试' : 'Clear failed, please retry');
      }
    });

    // file inputs
    $('#cameraInput').addEventListener('change', onPickFile);
    $('#albumInput').addEventListener('change', onPickFile);

    // meal type select
    $('#mealTypeSelect').addEventListener('change', (e) => {
      State.capture.mealType = e.target.value;
    });

    // analyze
    $('#analyzeBtn').addEventListener('click', onAnalyze);

    // result save buttons - use a flag to track edit mode
    // Use saving flag to prevent double-click
    let isSaving = false;

    // Mobile-friendly: bind directly to each button instead of delegation
    const saveMealHandler = (e) => {
      const btn = e.target.closest('button[data-meal]');
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();

      // Prevent double-click
      if (isSaving) return;
      if (!State.pendingMeal || State.pendingMeal.items.length === 0) {
        showToast(currentLang === 'zh' ? '没有可保存的食物' : 'No food items to save');
        return;
      }

      isSaving = true;
      const mealType = btn.dataset.meal;

      // Disable all save buttons and show loading
      const allBtns = $('#resultSheet').querySelectorAll('button[data-meal]');
      allBtns.forEach(b => {
        b.disabled = true;
        b.style.opacity = '0.5';
      });
      btn.textContent = currentLang === 'zh' ? '保存中...' : 'Saving...';

      try {
        // Check if we're editing an existing meal or saving a new one
        if (State.editingMealId) {
          // Update existing meal
          const day = todayKey();
          const updated = deepClone(State.pendingMeal);
          // Ensure the updated meal keeps the original ID
          updated.id = State.editingMealId;
          updated.mealType = mealType;
          updated.summary = sumMealItems(updated.items);

          const arr = [...(State.logs[day] || [])];
          const idx = arr.findIndex(x => x.id === State.editingMealId);
          let newLogs;
          if (idx >= 0) {
            arr[idx] = updated;
            newLogs = { ...State.logs, [day]: arr };
            saveJSON(LS_KEYS.logs, newLogs);  // 先保存，失败会抛异常
            State.logs = newLogs;  // 保存成功后更新内存
            gtmEvent('save_meal', { meal_type: mealType, action: 'edit' });
            showToast(currentLang === 'zh' ? '已更新记录' : 'Record updated');
          } else {
            // Meal not found - save as new instead
            console.warn('Original meal not found, saving as new');
            updated.id = cryptoRandomId();
            arr.unshift(updated);
            newLogs = { ...State.logs, [day]: arr };
            saveJSON(LS_KEYS.logs, newLogs);  // 先保存，失败会抛异常
            State.logs = newLogs;  // 保存成功后更新内存
            gtmEvent('save_meal', { meal_type: mealType, action: 'new_from_edit' });
            showToast(currentLang === 'zh' ? '已保存为新记录' : 'Saved as new record');
          }

          State.editingMealId = null;
          State.pendingMeal = null;
          setSheetOpen($('#resultSheet'), false);
          renderIndex();
          resetSaveButtons();
          isSaving = false;
        } else {
          // Save new meal - synchronous save, then close
          savePendingMealSync(mealType);
          showToast(currentLang === 'zh' ? `已保存到${getMealLabel(mealType)}` : `Saved to ${getMealLabel(mealType)}`);
          setSheetOpen($('#resultSheet'), false);
          renderIndex();
          resetSaveButtons();
          isSaving = false;
        }
      } catch (err) {
        console.error('Save error:', err);
        showToast(currentLang === 'zh' ? '保存失败，请重试' : 'Save failed, please retry');
        resetSaveButtons();
        isSaving = false;
      }
    };

    // Bind to each save button directly for better mobile support
    // Also add touchend for iOS Safari
    $('#resultSheet').querySelectorAll('button[data-meal]').forEach(btn => {
      btn.addEventListener('click', saveMealHandler);
      btn.addEventListener('touchend', (e) => {
        // Prevent ghost click on touch devices
        e.preventDefault();
        saveMealHandler(e);
      }, { passive: false });
    });

    function resetSaveButtons() {
      const allBtns = $('#resultSheet').querySelectorAll('button[data-meal]');
      allBtns.forEach(b => {
        b.disabled = false;
        b.style.opacity = '1';
        b.classList.remove('btn--primary'); // 移除高亮样式
        const type = b.dataset.meal;
        b.textContent = getMealLabel(type);
      });
      // 重新高亮智能推荐的餐次
      highlightSmartMealButton();
    }

    // manual add
    $('#addManualBtn').addEventListener('click', () => {
      const name = prompt(t('inputFoodName'));
      if (!name) return;
      const weight = Number(prompt(t('inputPortion'), '150'));
      const weight_g = clamp(Number.isFinite(weight) ? weight : 150, 10, 2000);

      // 简单匹配库；匹配不到则用"估算值"
      const found = findFoodByName(name);
      const item = found
        ? makeItemFromFood(found, weight_g, 0.6)
        : makeEstimatedItem(name, weight_g);

      item.manual = true;
      State.pendingMeal.items.push(item);
      gtmEvent('add_manual_food', { food_name: name });
      renderResultSheet(State.pendingMeal);
    });

    // retake button - go back to capture sheet
    $('#retakeBtn').addEventListener('click', () => {
      State.pendingMeal = null;
      State.editingMealId = null;
      setSheetOpen($('#resultSheet'), false);
      resetCaptureUI();
      setSheetOpen($('#captureSheet'), true);
      gtmEvent('retake_photo');
    });

    // save profile
    $('#saveProfileBtn').addEventListener('click', () => {
      const p = readProfileForm();
      p.goals = calcGoals(p);
      State.profile = p;
      saveJSON(LS_KEYS.profile, State.profile);
      gtmEvent('set_goal', { goal_type: p.goalType });
      setSheetOpen($('#profileSheet'), false);
      renderIndex();
    });

    renderIndex();
  }

  function resetCaptureUI() {
    State.capture.dataUrl = null;
    State.capture.mealType = getSmartMealType(); // 刷新智能餐次
    $('#previewWrap').hidden = true;
    $('#loadingBox').hidden = true;
    $('#cameraInput').value = '';
    $('#albumInput').value = '';
    // 同步下拉框显示
    const sel = $('#mealTypeSelect');
    if (sel) sel.value = State.capture.mealType;
  }

  async function onPickFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    $('#loadingBox').hidden = false;
    $('#loadingText').textContent = t('compressing');
    $('#previewWrap').hidden = true;

    try {
      const { dataUrl, blob } = await compressImage(file, { maxSide: 1280, quality: 0.72 });
      State.capture.dataUrl = dataUrl;
      State.capture.blob = blob;
      $('#previewImg').src = dataUrl;
      $('#previewWrap').hidden = false;
      gtmEvent('snap_photo');

      // Auto-trigger analysis after image is selected
      await onAnalyze();
    } catch (err) {
      alert(currentLang === 'zh' ? '读取图片失败，请重试。' : 'Failed to read image. Please try again.');
      console.error(err);
      $('#loadingBox').hidden = true;
    }
    // Note: loadingBox will be hidden by onAnalyze when it completes
  }

  async function onAnalyze() {
    if (!State.capture.dataUrl) {
      alert('请先拍照或选择图片。');
      return;
    }

    gtmEvent('analyze_food');
    $('#loadingBox').hidden = false;
    $('#loadingText').textContent = '识别中…（调用 AI 分析）';

    try {
      const res = await analyzeFoodImage({ dataUrl: State.capture.dataUrl, blob: State.capture.blob });
      const items = res.items;

      State.pendingMeal = {
        id: cryptoRandomId(),
        createdAt: Date.now(),
        mealType: State.capture.mealType,
        imageDataUrl: State.capture.dataUrl,
        items
      };
      State.editingMealId = null; // This is a new meal, not editing
      // compute summary
      const summary = sumMealItems(items);
      State.pendingMeal.summary = summary;

      // open result sheet
      $('#resultImg').src = State.capture.dataUrl;
      renderResultSheet(State.pendingMeal);
      setSheetOpen($('#captureSheet'), false);
      setSheetOpen($('#resultSheet'), true);

      // 高亮智能推荐的餐次按钮
      highlightSmartMealButton();
    } catch (err) {
      alert('识别失败，请重试或手动添加。');
      console.error(err);
    } finally {
      $('#loadingBox').hidden = true;
    }
  }

  function renderResultSheet(meal) {
    // summary
    meal.summary = sumMealItems(meal.items);
    $('#mealKcal').textContent = round0(meal.summary.kcal);
    $('#mealP').textContent = round0(meal.summary.p);
    $('#mealC').textContent = round0(meal.summary.c);
    $('#mealF').textContent = round0(meal.summary.f);

    // list
    const wrap = $('#foodList');
    wrap.innerHTML = '';
    meal.items.forEach((it) => {
      const el = document.createElement('div');
      el.className = 'food-item';
      const confLabel = t('confidence');
      const sourceLabel = it.manual ? t('manual') : t('recognized');
      const per100Label = t('per100g');
      el.innerHTML = `
        <div class="food-item__top">
          <div>
            <div class="food-item__name">${escapeHtml(it.name)}</div>
            <div class="food-item__sub">
              ${confLabel} ${(it.confidence * 100).toFixed(0)}% · ${sourceLabel} · ${per100Label} ${round0(it.per100.kcal)}kcal
            </div>
          </div>
          <div class="food-item__kcal">
            <div class="badge">${round0(it.kcal)} kcal</div>
          </div>
        </div>

        <div class="food-item__controls">
          <input class="range" type="range" min="10" max="800" step="5" value="${it.weight_g}" data-id="${it.id}" />
          <div class="weight-input-wrap">
            <input type="number" class="weight-input" min="10" max="2000" step="1" value="${round0(it.weight_g)}" data-weight-id="${it.id}" inputmode="numeric" />
            <span class="weight-unit">g</span>
          </div>
          <button class="small-btn danger" data-del="${it.id}">${t('delete')}</button>
        </div>
      `;
      wrap.appendChild(el);
    });

    // bind range + number input + delete (event delegation)
    wrap.oninput = (e) => {
      // Handle range slider
      const r = e.target.closest('input[type="range"][data-id]');
      if (r) {
        const id = r.dataset.id;
        const it = meal.items.find(x => x.id === id);
        if (!it) return;
        it.weight_g = Number(r.value);
        it.manual = true;
        recalcItem(it);
        // Sync number input
        const numInput = wrap.querySelector(`input[data-weight-id="${CSS.escape(id)}"]`);
        if (numInput) numInput.value = round0(it.weight_g);
        renderResultSheet(meal);
        return;
      }

      // Handle number input
      const numInput = e.target.closest('input[data-weight-id]');
      if (numInput) {
        const id = numInput.dataset.weightId;
        const it = meal.items.find(x => x.id === id);
        if (!it) return;
        const newVal = clamp(Number(numInput.value) || 10, 10, 2000);
        it.weight_g = newVal;
        it.manual = true;
        recalcItem(it);
        // Sync range slider
        const rangeInput = wrap.querySelector(`input[type="range"][data-id="${CSS.escape(id)}"]`);
        if (rangeInput) rangeInput.value = Math.min(newVal, 800);
        renderResultSheet(meal);
        return;
      }
    };

    wrap.onclick = (e) => {
      const del = e.target.closest('button[data-del]');
      if (!del) return;
      const id = del.dataset.del;
      meal.items = meal.items.filter(x => x.id !== id);
      renderResultSheet(meal);
    };
  }

  function savePendingMeal(mealType) {
    if (!State.pendingMeal) return;
    const day = todayKey();
    const meal = deepClone(State.pendingMeal);
    meal.mealType = mealType;
    meal.summary = sumMealItems(meal.items);

    // 先构建新的 logs 对象，尝试保存到 localStorage
    const newList = [...(State.logs[day] || [])];
    newList.unshift(meal);
    const newLogs = { ...State.logs, [day]: newList };

    saveJSON(LS_KEYS.logs, newLogs);  // 如果失败会抛异常

    // 保存成功，更新内存状态
    State.logs = newLogs;
    gtmEvent('save_meal', { meal_type: mealType });

    setSheetOpen($('#resultSheet'), false);
    State.pendingMeal = null;
    renderIndex();
  }

  function savePendingMealWithFeedback(mealType, callback) {
    if (!State.pendingMeal) {
      if (callback) callback();
      return;
    }

    const day = todayKey();
    const meal = deepClone(State.pendingMeal);

    // IMPORTANT: Always generate a new unique ID for new saves to prevent duplicate ID issues
    meal.id = cryptoRandomId();
    meal.mealType = mealType;
    meal.summary = sumMealItems(meal.items);

    // 先构建新的 logs 对象，尝试保存到 localStorage
    const newList = [...(State.logs[day] || [])];
    newList.unshift(meal);
    const newLogs = { ...State.logs, [day]: newList };

    saveJSON(LS_KEYS.logs, newLogs);  // 如果失败会抛异常

    // 保存成功，更新内存状态
    State.logs = newLogs;
    gtmEvent('save_meal', { meal_type: mealType });
    State.pendingMeal = null;

    // Show success toast
    const mealLabel = getMealLabel(mealType);
    showToast(currentLang === 'zh' ? `已保存到${mealLabel}` : `Saved to ${mealLabel}`);

    // Minimal delay for visual feedback
    setTimeout(() => {
      setSheetOpen($('#resultSheet'), false);
      renderIndex();
      if (callback) callback();
    }, 50);
  }

  // Synchronous save without callback - used by the new save handler
  function savePendingMealSync(mealType) {
    if (!State.pendingMeal) return;

    const day = todayKey();
    const meal = deepClone(State.pendingMeal);

    meal.id = cryptoRandomId();
    meal.mealType = mealType;
    meal.summary = sumMealItems(meal.items);

    // 先构建新的 logs 对象，尝试保存到 localStorage
    // 只有保存成功后才更新内存状态，避免保存失败但内存已修改的bug
    const newList = [...(State.logs[day] || [])];
    newList.unshift(meal);
    const newLogs = { ...State.logs, [day]: newList };

    saveJSON(LS_KEYS.logs, newLogs);  // 如果失败会抛异常，不会执行下面的代码

    // 保存成功，更新内存状态
    State.logs = newLogs;
    gtmEvent('save_meal', { meal_type: mealType });
    State.pendingMeal = null;
  }

  function renderIndex() {
    const day = todayKey();
    const records = State.logs[day] || [];

    // goals
    const g = State.profile.goals || calcGoals(State.profile);
    $('#kcalGoal').textContent = g.kcal;
    $('#pGoal').textContent = g.p;
    $('#cGoal').textContent = g.c;
    $('#fGoal').textContent = g.f;

    // sums
    const s = sumDay(records);
    $('#kcalNow').textContent = round0(s.kcal);
    $('#pNow').textContent = round0(s.p);
    $('#cNow').textContent = round0(s.c);
    $('#fNow').textContent = round0(s.f);

    // bars
    $('#kcalBar').style.width = `${clamp((s.kcal / g.kcal) * 100, 0, 120)}%`;
    $('#pBar').style.width = `${clamp((s.p / g.p) * 100, 0, 120)}%`;
    $('#cBar').style.width = `${clamp((s.c / g.c) * 100, 0, 120)}%`;
    $('#fBar').style.width = `${clamp((s.f / g.f) * 100, 0, 120)}%`;

    // advice
    $('#adviceText').textContent = buildAdvice(State.profile, s);

    // list
    const listEl = $('#todayList');
    listEl.innerHTML = '';
    $('#todayEmpty').hidden = records.length !== 0;

    records.forEach((r) => {
      const el = document.createElement('div');
      el.className = 'meal-item';
      const locale = currentLang === 'zh' ? 'zh-CN' : 'en-US';
      const time = new Date(r.createdAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
      const separator = currentLang === 'zh' ? '、' : ', ';
      const foods = r.items.map(x => x.name).slice(0, 4).join(separator) + (r.items.length > 4 ? '…' : '');
      const mealLabel = getMealLabel(r.mealType) || (currentLang === 'zh' ? '本餐' : 'Meal');
      const noFoodsText = currentLang === 'zh' ? '（无食物项）' : '(No items)';
      el.innerHTML = `
        <div class="meal-item__top">
          <div>
            <div class="meal-item__title">${mealLabel} <span class="badge">${time}</span></div>
            <div class="meal-item__meta">${escapeHtml(foods || noFoodsText)}</div>
          </div>
          <div class="meal-item__kpi">
            <div style="font-weight:900">${round0(r.summary.kcal)} kcal</div>
            <div class="meal-item__meta">P ${round0(r.summary.p)} / C ${round0(r.summary.c)} / F ${round0(r.summary.f)}</div>
          </div>
        </div>
        <div class="meal-item__actions">
          <button class="small-btn" data-view="${r.id}">${t('view')}</button>
          <button class="small-btn danger" data-delmeal="${r.id}">${t('delete')}</button>
        </div>
      `;
      listEl.appendChild(el);
    });

    // actions delegation - with protection against double-click
    listEl.onclick = (e) => {
      const del = e.target.closest('button[data-delmeal]');
      const view = e.target.closest('button[data-view]');
      if (del) {
        e.stopPropagation();
        e.preventDefault();

        // Prevent double-click using button's disabled state
        if (del.disabled) return;

        const id = del.dataset.delmeal;
        if (!confirm(t('confirmDelete'))) return;

        del.disabled = true;
        del.textContent = currentLang === 'zh' ? '删除中...' : 'Deleting...';

        try {
          // Find and remove only the FIRST matching record (safety measure)
          const arr = [...(State.logs[day] || [])];  // 创建副本
          const idx = arr.findIndex(x => x.id === id);
          if (idx >= 0) {
            arr.splice(idx, 1);
            const newLogs = { ...State.logs, [day]: arr };
            saveJSON(LS_KEYS.logs, newLogs);  // 先保存，失败会抛异常
            State.logs = newLogs;  // 保存成功后更新内存
            gtmEvent('delete_meal');
            showToast(currentLang === 'zh' ? '已删除' : 'Deleted');
          } else {
            showToast(currentLang === 'zh' ? '记录未找到' : 'Record not found');
          }
        } catch (err) {
          console.error('Delete error:', err);
          showToast(currentLang === 'zh' ? '删除失败，请重试' : 'Delete failed, please retry');
        }

        // Always re-render after a short delay
        setTimeout(() => {
          renderIndex();
        }, 150);
        return;
      }
      if (view) {
        const id = view.dataset.view;
        const meal = (State.logs[day] || []).find(x => x.id === id);
        if (!meal) return;
        // 复用结果页做"查看/编辑份量"
        State.pendingMeal = deepClone(meal);
        State.editingMealId = id; // Mark as editing existing meal
        $('#resultImg').src = meal.imageDataUrl || '';
        renderResultSheet(State.pendingMeal);

        setSheetOpen($('#resultSheet'), true);
        // 编辑时高亮原有餐次
        highlightSmartMealButton(meal.mealType);
      }
    };
  }

  function findFoodByName(name) {
    const n = name.trim().toLowerCase();
    return FOOD_DB.find(f => f.name.toLowerCase() === n || f.aliases?.some(a => a.toLowerCase() === n));
  }

  function makeEstimatedItem(name, weight_g) {
    // 兜底估算：按“普通熟食”每100g 150kcal，P8/C15/F5
    const per100 = { kcal: 150, p: 8, c: 15, f: 5 };
    const item = {
      id: cryptoRandomId(),
      foodId: 'custom',
      name,
      confidence: 0.5,
      weight_g,
      manual: true,
      kcal: 0, p: 0, c: 0, f: 0,
      per100
    };
    recalcItem(item);
    return item;
  }

  function fillProfileForm() {
    $('#goalType').value = State.profile.goalType || 'maintain';
    $('#sex').value = State.profile.sex || 'male';
    $('#age').value = State.profile.age ?? 28;
    $('#height').value = State.profile.height ?? 175;
    $('#weight').value = State.profile.weight ?? 70;
    $('#activity').value = String(State.profile.activity ?? 1.375);
  }

  function readProfileForm() {
    const p = {
      goalType: $('#goalType').value,
      sex: $('#sex').value,
      age: clamp(Number($('#age').value || 28), 10, 90),
      height: clamp(Number($('#height').value || 175), 120, 220),
      weight: clamp(Number($('#weight').value || 70), 35, 200),
      activity: Number($('#activity').value || 1.2)
    };
    return p;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  // ====== Dashboard ======
  function initDashboard() {
    const profile = loadJSON(LS_KEYS.profile, null) || defaultProfile();
    const logs = loadJSON(LS_KEYS.logs, {});
    const today = todayKey();
    const todaySum = sumDay(logs[today] || []);

    $('#jumpTodayBtn')?.addEventListener('click', () => location.href = './index.html');

    // Donut: macro kcal share
    const pK = todaySum.p * 4;
    const cK = todaySum.c * 4;
    const fK = todaySum.f * 9;
    const total = Math.max(1, pK + cK + fK);

    const donutCtx = document.getElementById('donutChart');
    if (donutCtx && window.Chart) {
      new Chart(donutCtx, {
        type: 'doughnut',
        data: {
          labels: ['蛋白', '碳水', '脂肪'],
          datasets: [{
            data: [pK, cK, fK],
            backgroundColor: ['#38bdf8', '#22c55e', '#fb7185'],
            borderColor: 'rgba(255,255,255,.10)',
            borderWidth: 1
          }]
        },
        options: {
          plugins: {
            legend: { labels: { color: '#e8f0ff' } },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const v = ctx.raw || 0;
                  const pct = (v / total) * 100;
                  return `${ctx.label}: ${round0(v)} kcal (${pct.toFixed(0)}%)`;
                }
              }
            }
          }
        }
      });
    }

    // Week series
    const days = [];
    const kcalSeries = [];
    const pSeries = [];
    const cSeries = [];
    const fSeries = [];

    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = todayKey(d);
      const label = `${d.getMonth() + 1}/${d.getDate()}`;
      const sum = sumDay(logs[key] || []);
      days.push(label);
      kcalSeries.push(round0(sum.kcal));
      pSeries.push(round0(sum.p));
      cSeries.push(round0(sum.c));
      fSeries.push(round0(sum.f));
    }

    const kcalCtx = document.getElementById('kcalBarChart');
    if (kcalCtx && window.Chart) {
      new Chart(kcalCtx, {
        type: 'bar',
        data: {
          labels: days,
          datasets: [{
            label: 'kcal',
            data: kcalSeries,
            backgroundColor: 'rgba(56,189,248,.55)',
            borderColor: 'rgba(56,189,248,.9)',
            borderWidth: 1
          }, {
            type: 'line',
            label: '目标',
            data: days.map(() => profile.goals?.kcal ?? 2000),
            borderColor: 'rgba(255,255,255,.35)',
            borderDash: [6, 6],
            pointRadius: 0
          }]
        },
        options: {
          scales: {
            x: { ticks: { color: '#9fb2d6' }, grid: { color: 'rgba(255,255,255,.06)' } },
            y: { ticks: { color: '#9fb2d6' }, grid: { color: 'rgba(255,255,255,.06)' } }
          },
          plugins: { legend: { labels: { color: '#e8f0ff' } } }
        }
      });
    }

    const pcfCtx = document.getElementById('pcfLineChart');
    if (pcfCtx && window.Chart) {
      new Chart(pcfCtx, {
        type: 'line',
        data: {
          labels: days,
          datasets: [
            { label: '蛋白(g)', data: pSeries, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,.15)', tension: .35 },
            { label: '碳水(g)', data: cSeries, borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,.12)', tension: .35 },
            { label: '脂肪(g)', data: fSeries, borderColor: '#fb7185', backgroundColor: 'rgba(251,113,133,.12)', tension: .35 }
          ]
        },
        options: {
          scales: {
            x: { ticks: { color: '#9fb2d6' }, grid: { color: 'rgba(255,255,255,.06)' } },
            y: { ticks: { color: '#9fb2d6' }, grid: { color: 'rgba(255,255,255,.06)' } }
          },
          plugins: { legend: { labels: { color: '#e8f0ff' } } }
        }
      });
    }
  }

  // ====== Boot ======
  function boot() {
    const path = location.pathname.split('/').pop() || 'index.html';
    if (path === 'dashboard.html') initDashboard();
    else initIndex();
  }

  window.App = { initDashboard };
  window.addEventListener('DOMContentLoaded', boot);
})();