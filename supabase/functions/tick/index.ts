// Edge Function `tick`: точка входа «будильника».
//
// Каждую минуту pg_cron (планировщик внутри базы) через pg_net (HTTP-клиент внутри базы)
// делает POST на адрес этой функции. Функция забирает наступившие напоминания и отправляет их.
//
// Защита: функция задеплоена с флагом --no-verify-jwt (pg_cron не умеет подписывать запросы
// ключами Supabase), поэтому проверяем собственный секрет TICK_SECRET из заголовка
// x-tick-secret. Без верного секрета отвечаем 401 и в базу даже не заглядываем.
//
// Вся логика — в logic.ts (покрыта тестами). Здесь только проводка.

import {
  abandonReminder,
  claimDueReminders,
  createDb,
  getSettings,
  markReminderSent,
  releaseReminder,
} from "../_shared/db.ts";
import {
  clearInlineKeyboard,
  sendTelegramMedia,
  sendTelegramMessage,
} from "../_shared/telegram_api.ts";
import { handleRequest, runTick } from "./logic.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Не задан секрет ${name}`);
  return value;
}

const botToken = requireEnv("TELEGRAM_BOT_TOKEN");
const tickSecret = requireEnv("TICK_SECRET");
const db = createDb();

const run = () =>
  runTick({
    store: {
      claimDueReminders: () => claimDueReminders(db),
      markReminderSent: (id, messageId, next) =>
        markReminderSent(db, id, messageId, next),
      releaseReminder: (id) => releaseReminder(db, id),
      abandonReminder: (id, next) => abandonReminder(db, id, next),
      getTimezone: async (chatId) => (await getSettings(db, chatId)).timezone,
    },
    send: (chatId, text, markup, attachment) =>
      attachment
        ? sendTelegramMedia(botToken, chatId, attachment, text, markup)
        : sendTelegramMessage(botToken, chatId, text, fetch, markup),
    clearKeyboard: (chatId, messageId) =>
      clearInlineKeyboard(botToken, chatId, messageId),
    log: (message) => console.error(message),
  });

Deno.serve((req) => handleRequest(req, { secret: tickSecret, run }));
