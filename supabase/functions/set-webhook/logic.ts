// Логика функции set-webhook: сообщает Telegram, на какой адрес присылать сообщения бота.
//
// Webhook («обратный вызов по адресу») регистрируется методом setWebhook. Вместе с адресом мы
// передаём secret_token: Telegram будет добавлять его в заголовок каждого запроса, а функция
// `bot` по нему отличает настоящего Telegram от подделки.
//
// Доступ к самой функции закрыт секретом TICK_SECRET (заголовок x-tick-secret): она может
// переключить бота, поэтому постороннему её вызывать нельзя.
//
// Методы запроса:  POST — зарегистрировать,  GET — показать состояние,  DELETE — снять.

import { callTelegramApi } from "../_shared/telegram_api.ts";
import { isAuthorized } from "../tick/logic.ts";

export type WebhookConfig = {
  botToken: string;
  webhookSecret: string; // TELEGRAM_WEBHOOK_SECRET
  botUrl: string; // куда Telegram должен слать сообщения: адрес функции bot
};

export async function handleRequest(
  req: Request,
  o: { secret: string; config: WebhookConfig; fetchFn?: typeof fetch },
): Promise<Response> {
  if (!isAuthorized(req.headers.get("x-tick-secret"), o.secret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { config, fetchFn } = o;
  try {
    switch (req.method) {
      case "POST": {
        const result = await callTelegramApi(config.botToken, "setWebhook", {
          url: config.botUrl,
          secret_token: config.webhookSecret,
          // Нужны только сообщения и нажатия кнопок: остальные события бот не обрабатывает.
          allowed_updates: ["message", "callback_query"],
        }, fetchFn);
        return Response.json({ ok: true, result });
      }
      case "GET": {
        // Состояние: адрес, сколько сообщений ждёт, последняя ошибка доставки. В нём нет секретов.
        return Response.json(
          await callTelegramApi(config.botToken, "getWebhookInfo", {}, fetchFn),
        );
      }
      case "DELETE": {
        const result = await callTelegramApi(
          config.botToken,
          "deleteWebhook",
          {},
          fetchFn,
        );
        return Response.json({ ok: true, result });
      }
      default:
        return new Response("Method Not Allowed", { status: 405 });
    }
  } catch (err) {
    // Сообщение уже очищено от токена (см. telegram_api.ts), его можно показать владельцу.
    const message = err instanceof Error ? err.message : "неизвестная ошибка";
    return new Response(message, { status: 502 });
  }
}
