// Тесты инструкции для нейросети (общей для Groq и Gemini): что в ней должно быть,
// чтобы даже небольшая модель правильно считала «пару дней», «обед» и т.п.

import { deepStrictEqual as assertEquals } from "node:assert";
import { buildSystemPrompt } from "../llm_common.ts";

const OPTS = {
  now: new Date("2026-10-28T09:00:00Z"), // среда, 12:00 по Москве
  timezone: "Europe/Moscow",
  defaultTime: "09:00",
};

Deno.test("промпт: расшифровка размытых слов («пара дней», «обед», «утром», «вечером»)", () => {
  const p = buildSystemPrompt(OPTS);
  assertEquals(p.includes("пара дней"), true);
  assertEquals(p.includes("обед"), true);
  assertEquals(p.includes("13:00"), true);
  assertEquals(p.includes("утром"), true);
  assertEquals(p.includes("вечером"), true);
});

Deno.test("промпт: пример с датой, посчитанной от «сейчас» (через два дня в обед → 30.10 13:00)", () => {
  const p = buildSystemPrompt(OPTS);
  assertEquals(p.includes("2026-10-30T13:00:00+03:00"), true);
  assertEquals(p.includes("2026-10-28"), true); // «сейчас» по-прежнему в промпте
});

Deno.test("промпт: напоминание не может быть раньше «сейчас» и «через N дней» считается от сегодняшней даты", () => {
  const p = buildSystemPrompt(OPTS);
  assertEquals(p.includes("не раньше"), true);
  assertEquals(p.includes("от сегодняшней даты"), true);
});
