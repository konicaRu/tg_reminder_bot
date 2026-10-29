// Тесты отправки сообщения в Telegram (Bot API). Сеть подменяем «фальшивым» fetch.
// Главное, что проверяем помимо успеха: токен бота не должен попадать в тексты ошибок,
// потому что ошибки пишутся в логи, а токен — это пароль бота.

import { deepStrictEqual as assertEquals } from "node:assert";
import { callTelegramApi, sendTelegramMessage } from "../telegram_api.ts";

const TOKEN = "123456:SECRET-TOKEN-VALUE";

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
  return { fetchFn, calls };
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("ожидали ошибку, но её не было");
}

Deno.test("sendMessage: успех → возвращает id сообщения, запрос составлен верно", async () => {
  const { fetchFn, calls } = fakeFetch(200, {
    ok: true,
    result: { message_id: 42 },
  });
  const id = await sendTelegramMessage(TOKEN, 555, "<b>привет</b>", fetchFn);
  assertEquals(id, 42);
  assertEquals(
    calls[0].url,
    `https://api.telegram.org/bot${TOKEN}/sendMessage`,
  );
  assertEquals(calls[0].init.method, "POST");
  assertEquals(JSON.parse(calls[0].init.body as string), {
    chat_id: 555,
    text: "<b>привет</b>",
    parse_mode: "HTML",
  });
});

Deno.test("sendMessage: Telegram вернул ошибку → бросаем код и описание, без токена", async () => {
  const { fetchFn } = fakeFetch(403, {
    ok: false,
    error_code: 403,
    description: "Forbidden: bot was blocked by the user",
  });
  const err = await errorOf(sendTelegramMessage(TOKEN, 555, "текст", fetchFn));
  assertEquals(err.message.includes("403"), true);
  assertEquals(err.message.includes("bot was blocked by the user"), true);
  assertEquals(err.message.includes("SECRET-TOKEN-VALUE"), false);
});

Deno.test("sendMessage: сеть упала → ошибка БЕЗ адреса с токеном (Deno кладёт адрес в текст ошибки)", async () => {
  const fetchFn = (() =>
    Promise.reject(
      new TypeError(
        `error sending request for url (https://api.telegram.org/bot${TOKEN}/sendMessage)`,
      ),
    )) as typeof fetch;
  const err = await errorOf(sendTelegramMessage(TOKEN, 555, "текст", fetchFn));
  assertEquals(err.message.includes("SECRET-TOKEN-VALUE"), false);
  assertEquals(err.message.includes("api.telegram.org"), false);
});

Deno.test("sendMessage: ответ не JSON → понятная ошибка", async () => {
  const fetchFn = (() =>
    Promise.resolve(
      new Response("<html>502 Bad Gateway</html>", { status: 502 }),
    )) as typeof fetch;
  const err = await errorOf(sendTelegramMessage(TOKEN, 555, "текст", fetchFn));
  assertEquals(err.message.includes("502"), true);
  assertEquals(err.message.includes("SECRET-TOKEN-VALUE"), false);
});

Deno.test("sendMessage: 200, но без message_id → ошибка (не считаем отправленным)", async () => {
  const { fetchFn } = fakeFetch(200, { ok: true, result: {} });
  const err = await errorOf(sendTelegramMessage(TOKEN, 555, "текст", fetchFn));
  assertEquals(err.message.length > 0, true);
});

// --- Общий вызов любого метода Bot API (нужен для setWebhook и getWebhookInfo) ---

Deno.test("callTelegramApi: возвращает result, запрос идёт на нужный метод", async () => {
  const { fetchFn, calls } = fakeFetch(200, {
    ok: true,
    result: { url: "https://x" },
  });
  const result = await callTelegramApi(TOKEN, "getWebhookInfo", {}, fetchFn);
  assertEquals(result, { url: "https://x" });
  assertEquals(
    calls[0].url,
    `https://api.telegram.org/bot${TOKEN}/getWebhookInfo`,
  );
});

Deno.test("callTelegramApi: ошибка Telegram → код и описание, без токена", async () => {
  const { fetchFn } = fakeFetch(401, {
    ok: false,
    error_code: 401,
    description: "Unauthorized",
  });
  const err = await errorOf(callTelegramApi(TOKEN, "setWebhook", {}, fetchFn));
  assertEquals(err.message.includes("401"), true);
  assertEquals(err.message.includes("Unauthorized"), true);
  assertEquals(err.message.includes("SECRET-TOKEN-VALUE"), false);
});

Deno.test("callTelegramApi: сеть упала → без адреса и токена", async () => {
  const fetchFn = (() =>
    Promise.reject(
      new TypeError(
        `error sending request for url (https://api.telegram.org/bot${TOKEN}/x)`,
      ),
    )) as typeof fetch;
  const err = await errorOf(callTelegramApi(TOKEN, "setWebhook", {}, fetchFn));
  assertEquals(err.message.includes("SECRET-TOKEN-VALUE"), false);
  assertEquals(err.message.includes("api.telegram.org"), false);
});
