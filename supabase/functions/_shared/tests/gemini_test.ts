// Тесты запасного разбора через Gemini. Сеть не трогаем: «фальшивый» fetch отвечает как Google.

import { deepStrictEqual as assertEquals } from "node:assert";
import { parseWithGemini } from "../gemini.ts";

const NOW = new Date("2026-10-28T09:00:00Z"); // среда, 12:00 по Москве
const OPTS = { now: NOW, timezone: "Europe/Moscow", defaultTime: "09:00" };

type Captured = { url: string; init: RequestInit };

// text — то, что «написала» модель; parts — если нужны свои части ответа; body — весь ответ целиком
function fakeGemini(
  o: { text?: string; parts?: unknown[]; status?: number; body?: unknown },
) {
  const calls: Captured[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const status = o.status ?? 200;
    const body = o.body ?? (status === 200
      ? {
        candidates: [{
          content: { parts: o.parts ?? [{ text: o.text ?? "" }] },
        }],
      }
      : { error: { message: "boom" } });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) as typeof fetch;
  return { fetchFn, calls };
}

const cfg = (fetchFn: typeof fetch) => ({
  apiKey: "AQ.test-key",
  model: "gemini-test",
  fetchFn,
});

const GOOD = JSON.stringify({
  text: "позвонить маме",
  remind_at: "2026-10-30T08:00:00+03:00",
  rrule: null,
  confidence: 0.9,
});

Deno.test("Gemini: корректный ответ → успешный разбор", async () => {
  const { fetchFn } = fakeGemini({ text: GOOD });
  const res = await parseWithGemini(
    "после обеда в четверг позвонить маме",
    OPTS,
    cfg(fetchFn),
  );
  if (!res.ok) throw new Error(`ожидали успех, получили ${res.reason}`);
  assertEquals(res.text, "позвонить маме");
  assertEquals(res.remindAt.toISOString(), "2026-10-30T05:00:00.000Z");
  assertEquals(res.rrule, null);
});

Deno.test("Gemini: адрес с моделью, ключ только в заголовке (не в адресе), JSON-режим и «сейчас» в промпте", async () => {
  const { fetchFn, calls } = fakeGemini({ text: GOOD });
  await parseWithGemini("через пару дней в обед созвон", OPTS, cfg(fetchFn));
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
  );
  assertEquals(calls[0].url.includes("AQ.test-key"), false);
  const headers = calls[0].init.headers as Record<string, string>;
  assertEquals(headers["x-goog-api-key"], "AQ.test-key");
  const body = JSON.parse(calls[0].init.body as string);
  assertEquals(body.generationConfig.responseMimeType, "application/json");
  assertEquals(body.generationConfig.temperature, 0);
  const system = body.systemInstruction.parts[0].text as string;
  assertEquals(system.includes("2026-10-28"), true);
  assertEquals(system.includes("Europe/Moscow"), true);
  assertEquals(body.contents[0].parts[0].text, "через пару дней в обед созвон");
});

Deno.test("Gemini: «мысли» модели (thought) отбрасываем, берём настоящий ответ", async () => {
  const { fetchFn } = fakeGemini({
    parts: [{ text: "Сначала подумаю…", thought: true }, { text: GOOD }],
  });
  const res = await parseWithGemini("что-то", OPTS, cfg(fetchFn));
  assertEquals(res.ok, true);
});

Deno.test("Gemini: HTTP 400 (регион) / 403 / 429 (лимит) / 500 / 503 → llm_unavailable", async () => {
  for (const status of [400, 403, 429, 500, 503]) {
    const { fetchFn } = fakeGemini({ status });
    assertEquals(await parseWithGemini("что-то", OPTS, cfg(fetchFn)), {
      ok: false,
      reason: "llm_unavailable",
    });
  }
});

Deno.test("Gemini: сеть упала → llm_unavailable", async () => {
  const fetchFn = (() => Promise.reject(new Error("network"))) as typeof fetch;
  assertEquals(await parseWithGemini("что-то", OPTS, cfg(fetchFn)), {
    ok: false,
    reason: "llm_unavailable",
  });
});

Deno.test("Gemini: пустой ответ (заблокирован/нет кандидатов) → llm_invalid", async () => {
  for (
    const body of [
      { candidates: [] },
      { promptFeedback: { blockReason: "SAFETY" } },
      { candidates: [{ finishReason: "SAFETY" }] },
    ]
  ) {
    const { fetchFn } = fakeGemini({ body });
    assertEquals(await parseWithGemini("что-то", OPTS, cfg(fetchFn)), {
      ok: false,
      reason: "llm_invalid",
    });
  }
});

Deno.test("Gemini: ответ не JSON или без обязательных полей → llm_invalid", async () => {
  for (const text of ["Конечно! Напомню завтра.", "{}", `{"text":"x"}`]) {
    const { fetchFn } = fakeGemini({ text });
    assertEquals(await parseWithGemini("что-то", OPTS, cfg(fetchFn)), {
      ok: false,
      reason: "llm_invalid",
    });
  }
});

Deno.test("Gemini: дата в прошлом → llm_invalid (та же проверка, что у Groq)", async () => {
  const past = JSON.stringify({
    text: "x",
    remind_at: "2026-10-01T08:00:00+03:00",
    rrule: null,
    confidence: 0.9,
  });
  const { fetchFn } = fakeGemini({ text: past });
  assertEquals(await parseWithGemini("что-то", OPTS, cfg(fetchFn)), {
    ok: false,
    reason: "llm_invalid",
  });
});
