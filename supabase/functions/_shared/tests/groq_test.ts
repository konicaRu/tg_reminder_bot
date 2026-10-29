// Тесты запасного разбора через Groq LLM.
// Сеть не трогаем: вместо настоящего fetch подставляем «фальшивый», который
// возвращает заготовленный ответ и запоминает, что у него спросили.

import { deepStrictEqual as assertEquals } from "node:assert";
import { parseWithLlm } from "../groq.ts";

const NOW = new Date("2026-10-28T09:00:00Z"); // среда, 12:00 по Москве
const OPTS = { now: NOW, timezone: "Europe/Moscow", defaultTime: "09:00" };

type Captured = { url: string; init: RequestInit };

// Фальшивый fetch: отвечает «как Groq», content — то, что модель «написала».
function fakeGroq(content: string, status = 200) {
  const calls: Captured[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = status === 200
      ? { choices: [{ message: { content } }] }
      : { error: { message: "boom" } };
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
  return { fetchFn, calls };
}

const cfg = (fetchFn: typeof fetch) => ({
  apiKey: "gsk_test",
  model: "test-model",
  fetchFn,
});

const GOOD = JSON.stringify({
  text: "позвонить маме",
  remind_at: "2026-10-30T08:00:00+03:00",
  rrule: null,
  confidence: 0.9,
});

Deno.test("Groq: корректный ответ → успешный разбор", async () => {
  const { fetchFn } = fakeGroq(GOOD);
  const res = await parseWithLlm(
    "после обеда в четверг позвонить маме",
    OPTS,
    cfg(fetchFn),
  );
  if (!res.ok) throw new Error(`ожидали успех, получили ${res.reason}`);
  assertEquals(res.text, "позвонить маме");
  assertEquals(res.remindAt.toISOString(), "2026-10-30T05:00:00.000Z");
  assertEquals(res.rrule, null);
  assertEquals(res.confidence, 0.9);
});

Deno.test("Groq: запрос уходит на нужный адрес с ключом, моделью и JSON-режимом", async () => {
  const { fetchFn, calls } = fakeGroq(GOOD);
  await parseWithLlm("через пару дней в обед созвон", OPTS, cfg(fetchFn));
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.groq.com/openai/v1/chat/completions");
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers["Authorization"], "Bearer gsk_test");
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.model, "test-model");
  assertEquals(body.response_format, { type: "json_object" });
  assertEquals(body.temperature, 0);
  const prompt = body.messages.map((m: { content: string }) => m.content).join(
    "\n",
  );
  // модель должна знать «сейчас» в поясе пользователя и сам текст
  assertEquals(prompt.includes("через пару дней в обед созвон"), true);
  assertEquals(prompt.includes("2026-10-28"), true);
  assertEquals(prompt.includes("+03:00"), true);
  assertEquals(prompt.includes("Europe/Moscow"), true);
});

Deno.test("Groq: ответ не JSON → llm_invalid", async () => {
  const { fetchFn } = fakeGroq("Конечно! Напомню завтра.");
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "llm_invalid" });
});

Deno.test("Groq: нет обязательных полей → llm_invalid", async () => {
  const { fetchFn } = fakeGroq(JSON.stringify({ text: "позвонить" }));
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "llm_invalid" });
});

Deno.test("Groq: дата без пояса (без +03:00/Z) → llm_invalid", async () => {
  const bad = JSON.stringify({
    text: "позвонить",
    remind_at: "2026-10-30T08:00:00",
    rrule: null,
    confidence: 0.9,
  });
  const { fetchFn } = fakeGroq(bad);
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "llm_invalid" });
});

Deno.test("Groq: дата не парсится → llm_invalid", async () => {
  const bad = JSON.stringify({
    text: "позвонить",
    remind_at: "завтра утром",
    rrule: null,
    confidence: 0.9,
  });
  const { fetchFn } = fakeGroq(bad);
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "llm_invalid" });
});

Deno.test("Groq: дата в прошлом → llm_invalid", async () => {
  const bad = JSON.stringify({
    text: "позвонить",
    remind_at: "2026-10-27T08:00:00+03:00",
    rrule: null,
    confidence: 0.9,
  });
  const { fetchFn } = fakeGroq(bad);
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "llm_invalid" });
});

Deno.test("Groq: низкая уверенность (< 0.5) → llm_invalid", async () => {
  const unsure = JSON.stringify({
    text: "позвонить",
    remind_at: "2026-10-30T08:00:00+03:00",
    rrule: null,
    confidence: 0.3,
  });
  const { fetchFn } = fakeGroq(unsure);
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "llm_invalid" });
});

Deno.test("Groq: confidence не число или вне 0..1 → llm_invalid", async () => {
  for (const confidence of ["высокая", 1.5, -1, null]) {
    const bad = JSON.stringify({
      text: "позвонить",
      remind_at: "2026-10-30T08:00:00+03:00",
      rrule: null,
      confidence,
    });
    const { fetchFn } = fakeGroq(bad);
    const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
    assertEquals(res, { ok: false, reason: "llm_invalid" });
  }
});

Deno.test("Groq: пустой текст напоминания → empty_text", async () => {
  const empty = JSON.stringify({
    text: "   ",
    remind_at: "2026-10-30T08:00:00+03:00",
    rrule: null,
    confidence: 0.9,
  });
  const { fetchFn } = fakeGroq(empty);
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "empty_text" });
});

Deno.test("Groq: поддержанный повтор (по будням) принимаем: строка нормализуется, первое срабатывание считаем сами", async () => {
  const repeat = JSON.stringify({
    text: "зарядка",
    remind_at: "2026-10-29T09:00:00+03:00",
    rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9",
    confidence: 0.95,
  });
  const { fetchFn } = fakeGroq(repeat);
  const res = await parseWithLlm("по будням зарядка", OPTS, cfg(fetchFn));
  if (!res.ok) throw new Error(res.reason);
  assertEquals(
    res.rrule,
    "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
  );
  assertEquals(res.remindAt.toISOString(), "2026-10-29T06:00:00.000Z");
});

Deno.test("Groq: повтор, который не умеем (раз в месяц, интервал), → repeat_unsupported", async () => {
  for (
    const rrule of [
      "FREQ=MONTHLY;BYMONTHDAY=15;BYHOUR=9",
      "FREQ=DAILY;INTERVAL=2;BYHOUR=9",
      "мусор",
    ]
  ) {
    const repeat = JSON.stringify({
      text: "оплата",
      remind_at: "2026-11-15T09:00:00+03:00",
      rrule,
      confidence: 0.95,
    });
    const { fetchFn } = fakeGroq(repeat);
    const res = await parseWithLlm("оплата", OPTS, cfg(fetchFn));
    assertEquals(res, { ok: false, reason: "repeat_unsupported" });
  }
});

Deno.test("Groq: ошибка сервера (HTTP 500) → llm_unavailable", async () => {
  const { fetchFn } = fakeGroq("", 500);
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "llm_unavailable" });
});

Deno.test("Groq: лимит запросов (HTTP 429) → llm_unavailable", async () => {
  const { fetchFn } = fakeGroq("", 429);
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "llm_unavailable" });
});

Deno.test("Groq: сеть упала (fetch бросил ошибку) → llm_unavailable", async () => {
  const fetchFn =
    (() => Promise.reject(new TypeError("network down"))) as typeof fetch;
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "llm_unavailable" });
});

Deno.test("Groq: ответ без choices → llm_invalid", async () => {
  const fetchFn = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )) as typeof fetch;
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(res, { ok: false, reason: "llm_invalid" });
});

Deno.test("Groq: ключ API не попадает в текст ошибки/результата", async () => {
  const { fetchFn } = fakeGroq("", 500);
  const res = await parseWithLlm("что-то", OPTS, cfg(fetchFn));
  assertEquals(JSON.stringify(res).includes("gsk_test"), false);
});

// --- «Думающие» модели (gpt-oss) тратят лимит токенов на рассуждения ----------

Deno.test("Groq: gpt-oss → просим думать поменьше (reasoning_effort: low) и даём запас токенов", async () => {
  const { fetchFn, calls } = fakeGroq(GOOD);
  const c = { apiKey: "gsk_test", model: "openai/gpt-oss-20b", fetchFn };
  await parseWithLlm("через пару дней в обед созвон", OPTS, c);
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.reasoning_effort, "low");
  assertEquals(body.max_tokens >= 1000, true);
});

Deno.test("Groq: обычная модель → параметра reasoning_effort нет (иначе Groq вернёт 400)", async () => {
  const { fetchFn, calls } = fakeGroq(GOOD);
  await parseWithLlm("через пару дней в обед созвон", OPTS, cfg(fetchFn));
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals("reasoning_effort" in body, false);
  assertEquals(body.max_tokens >= 1000, true);
});
