// Edge Function `bot`: точка входа для Telegram.
//
// Как это работает: мы один раз говорим Telegram «присылай все сообщения на этот адрес»
// (это и есть webhook — «обратный вызов по адресу»). Каждое сообщение или нажатие кнопки
// Telegram отправляет сюда POST-запросом, функция просыпается, отвечает и засыпает.
// Памяти между запросами нет: всё нужное лежит в базе.
//
// Здесь только «проводка» и безопасность. Вся логика — в handlers.ts (и она покрыта тестами).
//
// Деплой: `supabase functions deploy bot --no-verify-jwt`. Флаг нужен, потому что Telegram
// не умеет присылать JWT-токен Supabase, поэтому проверку «свой/чужой» делаем сами (см. ниже).

import { Bot, type Context, GrammyError, webhookCallback } from "npm:grammy@1";
import {
  cancelReminder,
  clearSession,
  createDb,
  createReminder,
  getReminder,
  getSession,
  getSettings,
  listPendingReminders,
  setSession,
  stopReminder,
  updateReminder,
} from "../_shared/db.ts";
import { parseWithLlm } from "../_shared/groq.ts";
import { parseReminder } from "../_shared/parser/mod.ts";
import {
  createHandlers,
  type Io,
  isAllowed,
  parseAllowedIds,
  type Store,
} from "./handlers.ts";

// --- Секреты (лежат в Supabase Secrets, в коде их нет) ------------------------
function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Не задан секрет ${name}`);
  return value;
}

const token = requireEnv("TELEGRAM_BOT_TOKEN");
const webhookSecret = requireEnv("TELEGRAM_WEBHOOK_SECRET");
// Если ALLOWED_USER_ID кривой, parseAllowedIds бросит ошибку: лучше не запуститься, чем пустить всех.
const allowedUserIds = parseAllowedIds(Deno.env.get("ALLOWED_USER_ID"));

// Groq необязателен: нет ключа или модели → бот работает только на правилах.
const groqKey = Deno.env.get("GROQ_API_KEY");
const groqModel = Deno.env.get("GROQ_LLM_MODEL");

// --- Подключаем «мозг» к настоящей базе и парсеру -----------------------------
const db = createDb();
const store: Store = {
  getSettings: (chatId) => getSettings(db, chatId),
  getSession: (chatId) => getSession(db, chatId),
  setSession: (chatId, state, payload) =>
    setSession(db, chatId, state, payload),
  clearSession: (chatId) => clearSession(db, chatId),
  createReminder: (r) => createReminder(db, r),
  listPendingReminders: (chatId) => listPendingReminders(db, chatId),
  cancelReminder: (chatId, id) => cancelReminder(db, chatId, id),
  stopReminder: (chatId, id) => stopReminder(db, chatId, id),
  getReminder: (chatId, id) => getReminder(db, chatId, id),
  updateReminder: (chatId, id, patch) => updateReminder(db, chatId, id, patch),
};

const handlers = createHandlers({
  store,
  parse: parseReminder,
  llm: groqKey && groqModel
    ? (input, opts) =>
      parseWithLlm(input, opts, { apiKey: groqKey, model: groqModel })
    : undefined,
  now: () => new Date(),
  newId: () => crypto.randomUUID().slice(0, 8), // короткий код черновика
});

// --- Telegram ----------------------------------------------------------------
const bot = new Bot(token);

// Защита №1 — whitelist. Этот «посредник» (middleware) стоит первым и пропускает дальше
// только личные сообщения от людей из списка. Остальным бот не отвечает вообще: для чужих его
// как будто не существует.
bot.use(async (ctx, next) => {
  if (
    ctx.chat?.type !== "private" || !isAllowed(ctx.from?.id, allowedUserIds)
  ) {
    return;
  }
  await next();
});

// Io — «канал связи» для handlers: превращает наши reply/edit/answer в вызовы Telegram.
// parse_mode "HTML" включает <b>жирный</b>; тексты пользователя экранируются в telegram.ts.
function ioFor(ctx: Context): Io {
  return {
    chatId: ctx.chat!.id,
    reply: async (text, markup) => {
      await ctx.reply(text, { parse_mode: "HTML", reply_markup: markup });
    },
    edit: async (text, markup) => {
      try {
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: markup,
        });
      } catch (err) {
        // Telegram ругается, если новый текст совпал со старым. Для нас это не ошибка.
        if (
          err instanceof GrammyError &&
          err.description.includes("message is not modified")
        ) {
          return;
        }
        throw err;
      }
    },
    answer: async (text) => {
      await ctx.answerCallbackQuery(text ? { text } : undefined);
    },
  };
}

bot.command("start", (ctx) => handlers.start(ioFor(ctx)));
bot.command("list", (ctx) => handlers.list(ioFor(ctx)));
bot.on(
  "callback_query:data",
  (ctx) => handlers.callback(ioFor(ctx), ctx.callbackQuery.data),
);
bot.on("message:text", (ctx) => handlers.text(ioFor(ctx), ctx.message.text));
bot.on("message", (ctx) => handlers.unsupported(ioFor(ctx))); // фото, голос, файлы…

// Если что-то сломалось, логируем и отвечаем Telegram «ок». Иначе Telegram решит, что запрос
// не дошёл, и будет присылать то же сообщение снова и снова. В лог пишем только текст ошибки.
bot.catch(async (err) => {
  console.error(
    "Ошибка обработки обновления:",
    err.error instanceof Error ? err.error.message : err.error,
  );
  try {
    await err.ctx.reply("Что-то пошло не так, попробуй ещё раз.");
  } catch {
    // даже ответить не получилось — ничего не поделаешь
  }
});

// Защита №2 — секретный заголовок. Когда мы регистрируем webhook, мы просим Telegram добавлять
// к каждому запросу заголовок X-Telegram-Bot-Api-Secret-Token с нашим секретом. grammY сверяет
// его сам и при несовпадении отвечает 401. Так посторонний, узнавший адрес функции, не сможет
// подсунуть боту поддельное «сообщение от Telegram».
const handleUpdate = webhookCallback(bot, "std/http", {
  secretToken: webhookSecret,
});
Deno.serve((req) => handleUpdate(req));
