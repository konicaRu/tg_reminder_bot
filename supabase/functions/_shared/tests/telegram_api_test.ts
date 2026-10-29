// Тесты отправки сообщения в Telegram (Bot API). Сеть подменяем «фальшивым» fetch.
// Главное, что проверяем помимо успеха: токен бота не должен попадать в тексты ошибок,
// потому что ошибки пишутся в логи, а токен — это пароль бота.

import { deepStrictEqual as assertEquals } from "node:assert";
import {
  callTelegramApi,
  clearInlineKeyboard,
  downloadTelegramFile,
  sendTelegramMessage,
} from "../telegram_api.ts";

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

// --- Кнопки под сообщением и их снятие -------------------------------------------

Deno.test("sendMessage: с кнопками → reply_markup попадает в запрос", async () => {
  const { fetchFn, calls } = fakeFetch(200, {
    ok: true,
    result: { message_id: 7 },
  });
  const markup = {
    inline_keyboard: [[{ text: "✅ Готово", callback_data: "done:x" }]],
  };
  await sendTelegramMessage(TOKEN, 555, "текст", fetchFn, markup);
  assertEquals(JSON.parse(calls[0].init.body as string).reply_markup, markup);
});

Deno.test("sendMessage: без кнопок → поля reply_markup в запросе нет", async () => {
  const { fetchFn, calls } = fakeFetch(200, {
    ok: true,
    result: { message_id: 7 },
  });
  await sendTelegramMessage(TOKEN, 555, "текст", fetchFn);
  assertEquals(
    "reply_markup" in JSON.parse(calls[0].init.body as string),
    false,
  );
});

Deno.test("clearInlineKeyboard: просит Telegram убрать кнопки у конкретного сообщения", async () => {
  const { fetchFn, calls } = fakeFetch(200, { ok: true, result: true });
  await clearInlineKeyboard(TOKEN, 555, 42, fetchFn);
  assertEquals(
    calls[0].url,
    `https://api.telegram.org/bot${TOKEN}/editMessageReplyMarkup`,
  );
  assertEquals(JSON.parse(calls[0].init.body as string), {
    chat_id: 555,
    message_id: 42,
    reply_markup: { inline_keyboard: [] },
  });
});

Deno.test("clearInlineKeyboard: ошибка Telegram → исключение без токена (вызывающий решает, игнорировать ли)", async () => {
  const { fetchFn } = fakeFetch(400, {
    ok: false,
    error_code: 400,
    description: "Bad Request: message to edit not found",
  });
  const err = await errorOf(clearInlineKeyboard(TOKEN, 555, 42, fetchFn));
  assertEquals(err.message.includes("message to edit not found"), true);
  assertEquals(err.message.includes("SECRET-TOKEN-VALUE"), false);
});

// --- Скачивание файла (голосовые) --------------------------------------------

// Фальшивый Telegram: getFile отвечает JSON, скачивание файла отдаёт байты.
function fakeFiles(o: {
  fileSize?: number;
  filePath?: string;
  bytes?: Uint8Array;
  getFileStatus?: number;
  downloadThrows?: boolean;
}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/getFile")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            o.getFileStatus && o.getFileStatus !== 200
              ? { ok: false, error_code: o.getFileStatus, description: "bad" }
              : {
                ok: true,
                result: {
                  file_id: "F1",
                  file_path: o.filePath ?? "voice/file_1.oga",
                  ...(o.fileSize !== undefined
                    ? { file_size: o.fileSize }
                    : {}),
                },
              },
          ),
          { status: o.getFileStatus ?? 200 },
        ),
      );
    }
    if (o.downloadThrows) {
      // как настоящий Deno: текст ошибки содержит адрес с токеном
      return Promise.reject(
        new Error(`error sending request for url (${url})`),
      );
    }
    return Promise.resolve(
      new Response(
        (o.bytes ?? new Uint8Array([1, 2, 3])).slice().buffer as ArrayBuffer,
      ),
    );
  }) as typeof fetch;
  return { fetchFn, calls };
}

Deno.test("скачивание файла: getFile → скачивание по пути, возвращает байты", async () => {
  const { fetchFn, calls } = fakeFiles({ fileSize: 3 });
  const bytes = await downloadTelegramFile(
    TOKEN,
    "F1",
    { maxBytes: 1000 },
    fetchFn,
  );
  assertEquals(Array.from(bytes), [1, 2, 3]);
  assertEquals(calls[0].url, `https://api.telegram.org/bot${TOKEN}/getFile`);
  assertEquals(JSON.parse(calls[0].init!.body as string), { file_id: "F1" });
  assertEquals(
    calls[1].url,
    `https://api.telegram.org/file/bot${TOKEN}/voice/file_1.oga`,
  );
});

Deno.test("скачивание файла: заявленный размер больше лимита → ошибка, файл не качаем", async () => {
  const { fetchFn, calls } = fakeFiles({ fileSize: 9_000_000 });
  const err = await errorOf(
    downloadTelegramFile(TOKEN, "F1", { maxBytes: 5_000_000 }, fetchFn),
  );
  assertEquals(err.message.includes("слишком большой"), true);
  assertEquals(calls.length, 1); // только getFile
});

Deno.test("скачивание файла: размер не заявлен, но байт больше лимита → ошибка", async () => {
  const { fetchFn } = fakeFiles({ bytes: new Uint8Array(50) });
  const err = await errorOf(
    downloadTelegramFile(TOKEN, "F1", { maxBytes: 10 }, fetchFn),
  );
  assertEquals(err.message.includes("слишком большой"), true);
});

Deno.test("скачивание файла: сбои getFile и сети не раскрывают токен", async () => {
  const a = await errorOf(
    downloadTelegramFile(
      TOKEN,
      "F1",
      { maxBytes: 100 },
      fakeFiles({ getFileStatus: 400 }).fetchFn,
    ),
  );
  assertEquals(a.message.includes(TOKEN), false);
  const b = await errorOf(
    downloadTelegramFile(
      TOKEN,
      "F1",
      { maxBytes: 100 },
      fakeFiles({ downloadThrows: true }).fetchFn,
    ),
  );
  assertEquals(b.message.includes(TOKEN), false);
  assertEquals(b.message.includes("Telegram"), true);
});
