// Тесты функции set-webhook: «регистратор» адреса бота у Telegram.
// Webhook — это адрес, на который Telegram присылает все сообщения бота. Его нужно один раз
// сообщить Telegram методом setWebhook. С компьютера в РФ Telegram недоступен, поэтому
// запрос делает эта функция, работающая на сервере Supabase.

import { deepStrictEqual as assertEquals } from "node:assert";
import { handleRequest, type WebhookConfig } from "../logic.ts";

const SECRET = "admin-secret-123"; // TICK_SECRET: пускает к функции только владельца
const TOKEN = "123456:SECRET-BOT-TOKEN";
const WEBHOOK_SECRET = "webhook-secret-xyz";

const config: WebhookConfig = {
  botToken: TOKEN,
  webhookSecret: WEBHOOK_SECRET,
  botUrl: "https://abc.supabase.co/functions/v1/bot",
};

// Фальшивый Telegram: запоминает запросы, отвечает заготовкой.
function fakeTelegram(result: unknown = true, fail = false) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({
      method: url.split("/").pop()!,
      body: JSON.parse((init.body as string) ?? "{}"),
    });
    return Promise.resolve(
      fail
        ? new Response(
          JSON.stringify({
            ok: false,
            error_code: 401,
            description: "Unauthorized",
          }),
          { status: 401 },
        )
        : new Response(JSON.stringify({ ok: true, result }), { status: 200 }),
    );
  }) as typeof fetch;
  return { fetchFn, calls };
}

const req = (
  method: string,
  headers: Record<string, string> = { "x-tick-secret": SECRET },
) => new Request("http://x/", { method, headers });

Deno.test("POST: регистрирует webhook с адресом бота, секретным заголовком и нужными типами событий", async () => {
  const t = fakeTelegram(true);
  const res = await handleRequest(req("POST"), {
    secret: SECRET,
    config,
    fetchFn: t.fetchFn,
  });
  assertEquals(res.status, 200);
  assertEquals(t.calls.length, 1);
  assertEquals(t.calls[0].method, "setWebhook");
  assertEquals(t.calls[0].body, {
    url: "https://abc.supabase.co/functions/v1/bot",
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
  });
});

Deno.test("POST: в ответе нет ни токена бота, ни секрета webhook", async () => {
  const t = fakeTelegram(true);
  const res = await handleRequest(req("POST"), {
    secret: SECRET,
    config,
    fetchFn: t.fetchFn,
  });
  const text = await res.text();
  assertEquals(text.includes("SECRET-BOT-TOKEN"), false);
  assertEquals(text.includes(WEBHOOK_SECRET), false);
});

Deno.test("GET: показывает состояние webhook (адрес, очередь, последняя ошибка)", async () => {
  const info = {
    url: "https://abc.supabase.co/functions/v1/bot",
    pending_update_count: 0,
    last_error_message: "",
    has_custom_certificate: false,
  };
  const t = fakeTelegram(info);
  const res = await handleRequest(req("GET"), {
    secret: SECRET,
    config,
    fetchFn: t.fetchFn,
  });
  assertEquals(res.status, 200);
  assertEquals(t.calls[0].method, "getWebhookInfo");
  assertEquals((await res.json()).url, info.url);
});

Deno.test("DELETE: снимает webhook", async () => {
  const t = fakeTelegram(true);
  const res = await handleRequest(req("DELETE"), {
    secret: SECRET,
    config,
    fetchFn: t.fetchFn,
  });
  assertEquals(res.status, 200);
  assertEquals(t.calls[0].method, "deleteWebhook");
});

Deno.test("без секрета или с неверным → 401, Telegram не вызываем", async () => {
  const wrongHeaders: Record<string, string>[] = [{}, {
    "x-tick-secret": "wrong",
  }];
  for (const headers of wrongHeaders) {
    const t = fakeTelegram(true);
    const res = await handleRequest(req("POST", headers), {
      secret: SECRET,
      config,
      fetchFn: t.fetchFn,
    });
    assertEquals(res.status, 401);
    assertEquals(t.calls.length, 0);
  }
});

Deno.test("неподдерживаемый метод → 405", async () => {
  const t = fakeTelegram(true);
  const res = await handleRequest(req("PUT"), {
    secret: SECRET,
    config,
    fetchFn: t.fetchFn,
  });
  assertEquals(res.status, 405);
  assertEquals(t.calls.length, 0);
});

Deno.test("ошибка Telegram → 502 с причиной, но без токена", async () => {
  const t = fakeTelegram(null, true);
  const res = await handleRequest(req("POST"), {
    secret: SECRET,
    config,
    fetchFn: t.fetchFn,
  });
  assertEquals(res.status, 502);
  const text = await res.text();
  assertEquals(text.includes("401"), true);
  assertEquals(text.includes("SECRET-BOT-TOKEN"), false);
});
