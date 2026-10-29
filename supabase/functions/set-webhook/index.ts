// Edge Function `set-webhook`: одноразовый «регистратор» webhook (адреса бота у Telegram).
//
// Нужна потому, что с некоторых сетей (например, из РФ) api.telegram.org недоступен, а с серверов
// Supabase доступен. Задеплоить → вызвать один раз → (по желанию) удалить с сервера:
//   supabase functions delete set-webhook
// Код остаётся в репозитории на случай, если webhook понадобится зарегистрировать заново.
//
// Деплой: `supabase functions deploy set-webhook --no-verify-jwt --use-api`.
// Защита — секрет TICK_SECRET в заголовке x-tick-secret.

import { handleRequest } from "./logic.ts";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Не задан секрет ${name}`);
  return value;
}

// SUPABASE_URL (вида https://<ref>.supabase.co) Supabase подставляет в функции сам.
const config = {
  botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  webhookSecret: requireEnv("TELEGRAM_WEBHOOK_SECRET"),
  botUrl: `${requireEnv("SUPABASE_URL")}/functions/v1/bot`,
};
const secret = requireEnv("TICK_SECRET");

Deno.serve((req) => handleRequest(req, { secret, config }));
