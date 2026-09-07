// Telegram KBJU bot for Deno Deploy.
// Set BOT_TOKEN and WEBHOOK_KEY as secrets in Deno Deploy before publishing.

const ACTIVITY = {
  "Минимум (сижу целый день)": 1.2,
  "Легкая (1–3 тренировки)": 1.375,
  "Средняя (3–5 тренировок)": 1.55,
  "Высокая (каждый день)": 1.725,
  "Профи (спортсмен)": 1.9,
};

const GENDERS = new Set(["Мужской", "Женский"]);
const GOALS = new Set(["Похудение", "Набор массы", "Сушка"]);
const STATE_TTL_MS = 24 * 60 * 60 * 1000;

const genderKeyboard = {
  keyboard: [[{ text: "Мужской" }, { text: "Женский" }]],
  resize_keyboard: true,
};

const activityKeyboard = {
  keyboard: [
    [{ text: "Минимум (сижу целый день)" }],
    [{ text: "Легкая (1–3 тренировки)" }],
    [{ text: "Средняя (3–5 тренировок)" }],
    [{ text: "Высокая (каждый день)" }],
    [{ text: "Профи (спортсмен)" }],
  ],
  resize_keyboard: true,
};

const goalKeyboard = {
  keyboard: [
    [{ text: "Похудение" }],
    [{ text: "Набор массы" }],
    [{ text: "Сушка" }],
  ],
  resize_keyboard: true,
};

const removeKeyboard = { remove_keyboard: true };
const kv = await Deno.openKv();

function isStartCommand(text) {
  return /^\/start(?:@\w+)?(?:\s|$)/i.test(text);
}

function integerInRange(text, min, max) {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function weightInRange(text) {
  const normalized = text.replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const value = Number(normalized);
  return value >= 25 && value <= 350 ? value : null;
}

async function sendMessage(chatId, text, replyMarkup) {
  const token = Deno.env.get("BOT_TOKEN");
  if (!token) throw new Error("BOT_TOKEN is not configured");

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram error: ${await response.text()}`);
  }
}

async function loadState(key) {
  const result = await kv.get(["state", key]);
  return result.value;
}

async function saveState(key, state) {
  await kv.set(["state", key], state, { expireIn: STATE_TTL_MS });
}

async function clearState(key) {
  await kv.delete(["state", key]);
}

async function startCalculation(key, chatId) {
  await saveState(key, { step: "gender" });
  await sendMessage(
    chatId,
    "Привет! 👋 Я рассчитаю твоё КБЖУ.\n\nВыбери свой пол:",
    genderKeyboard,
  );
}

async function handleMessage(message) {
  const text = message.text?.trim();
  if (!text || !message.from || !message.chat) return;

  const chatId = message.chat.id;
  const key = `${chatId}:${message.from.id}`;

  if (isStartCommand(text)) {
    await startCalculation(key, chatId);
    return;
  }

  const state = await loadState(key);
  if (!state) {
    await sendMessage(chatId, "Нажми /start, чтобы начать расчёт.");
    return;
  }

  if (state.step === "gender") {
    if (!GENDERS.has(text)) {
      await sendMessage(chatId, "Выбери пол кнопкой ниже.", genderKeyboard);
      return;
    }

    await saveState(key, { step: "age", gender: text });
    await sendMessage(
      chatId,
      "Отлично! Теперь напиши возраст цифрой, например: 22",
      removeKeyboard,
    );
    return;
  }

  if (state.step === "age") {
    const age = integerInRange(text, 10, 120);
    if (age === null) {
      await sendMessage(chatId, "Введи корректный возраст числом, например: 22");
      return;
    }

    await saveState(key, { ...state, step: "height", age });
    await sendMessage(chatId, "Теперь напиши рост в сантиметрах, например: 175");
    return;
  }

  if (state.step === "height") {
    const height = integerInRange(text, 100, 250);
    if (height === null) {
      await sendMessage(chatId, "Введи корректный рост в см, например: 175");
      return;
    }

    await saveState(key, { ...state, step: "weight", height });
    await sendMessage(chatId, "Напиши вес в кг, например: 70.5");
    return;
  }

  if (state.step === "weight") {
    const weight = weightInRange(text);
    if (weight === null) {
      await sendMessage(chatId, "Введи корректный вес в кг, например: 70 или 70.5");
      return;
    }

    await saveState(key, { ...state, step: "activity", weight });
    await sendMessage(chatId, "Выбери уровень активности:", activityKeyboard);
    return;
  }

  if (state.step === "activity") {
    if (!(text in ACTIVITY)) {
      await sendMessage(chatId, "Выбери уровень активности кнопкой ниже.", activityKeyboard);
      return;
    }

    await saveState(key, { ...state, step: "goal", activity: ACTIVITY[text] });
    await sendMessage(chatId, "Выбери свою цель:", goalKeyboard);
    return;
  }

  if (state.step === "goal") {
    if (!GOALS.has(text)) {
      await sendMessage(chatId, "Выбери цель кнопкой ниже.", goalKeyboard);
      return;
    }

    const bmr =
      10 * state.weight +
      6.25 * state.height -
      5 * state.age +
      (state.gender === "Мужской" ? 5 : -161);

    let calories = bmr * state.activity;
    let protein;
    let fat;
    let goalText;

    if (text === "Похудение") {
      calories *= 0.85;
      protein = state.weight * 2.0;
      fat = state.weight * 0.8;
      goalText = "🔥 Похудение — дефицит 15%";
    } else if (text === "Набор массы") {
      calories *= 1.1;
      protein = state.weight * 2.0;
      fat = state.weight * 1.0;
      goalText = "💪 Набор массы — профицит 10%";
    } else {
      calories *= 0.85;
      protein = state.weight * 2.2;
      fat = state.weight * 0.8;
      goalText = "🏋️ Сушка — дефицит 15%";
    }

    const carbs = Math.max(0, (calories - protein * 4 - fat * 9) / 4);

    await sendMessage(
      chatId,
      `✅ Твоя норма КБЖУ:\n\n` +
        `📌 Цель: ${goalText}\n\n` +
        `🔥 Калории: ${Math.round(calories)} ккал\n` +
        `🥩 Белки: ${Math.round(protein)} г\n` +
        `🥑 Жиры: ${Math.round(fat)} г\n` +
        `🍚 Углеводы: ${Math.round(carbs)} г`,
      removeKeyboard,
    );
    await clearState(key);
    return;
  }

  await startCalculation(key, chatId);
}

Deno.serve(async (request) => {
  const url = new URL(request.url);

  if (request.method !== "POST" || url.pathname !== "/telegram") {
    return new Response("KBJU bot is online", { status: 200 });
  }

  const webhookKey = Deno.env.get("WEBHOOK_KEY");
  if (!webhookKey || url.searchParams.get("key") !== webhookKey) {
    return new Response("Forbidden", { status: 403 });
  }

  try {
    const update = await request.json();
    if (update.message) await handleMessage(update.message);
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error(error);
    return new Response("Bad request", { status: 400 });
  }
});
