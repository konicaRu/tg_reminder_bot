// Тесты: служебное слово «напомни» вырезается из текста напоминания в любом месте фразы,
// а не только в начале. «Сейчас» то же, что в parser_test.ts: среда 28.10.2026, 12:00 по Москве.

import { deepStrictEqual as assertEquals } from "node:assert";
import { parseReminder } from "../mod.ts";

const NOW = new Date("2026-10-28T09:00:00Z");
const OPTS = { now: NOW, timezone: "Europe/Moscow", defaultTime: "09:00" };

const CASES: { input: string; text: string; at?: string }[] = [
  {
    input: "через минуту напомни позвонить",
    text: "позвонить",
    at: "2026-10-28T09:01:00Z",
  },
  {
    input: "завтра в 9 напомни мне про встречу",
    text: "про встречу",
    at: "2026-10-29T06:00:00Z",
  },
  {
    input: "позвонить маме напомни завтра в 9",
    text: "позвонить маме",
    at: "2026-10-29T06:00:00Z",
  },
  {
    input: "завтра в 9 напомните мне позвонить",
    text: "позвонить",
    at: "2026-10-29T06:00:00Z",
  },
  {
    input: "Напомни, завтра в 9, позвонить",
    text: "позвонить",
    at: "2026-10-29T06:00:00Z",
  },
  {
    input: "напомни мне завтра в 9 созвон", // как раньше: слово в начале
    text: "созвон",
    at: "2026-10-29T06:00:00Z",
  },
  // другие слова с тем же корнем не трогаем
  {
    input: "завтра в 9 купить напоминание",
    text: "купить напоминание",
    at: "2026-10-29T06:00:00Z",
  },
  {
    input: "завтра в 9 напомнить маме про врача",
    text: "напомнить маме про врача",
    at: "2026-10-29T06:00:00Z",
  },
];

for (const c of CASES) {
  Deno.test(`«напомни» где угодно: «${c.input}»`, () => {
    const res = parseReminder(c.input, OPTS);
    if (!res.ok) throw new Error(`ожидали успех, получили ${res.reason}`);
    assertEquals(res.text, c.text);
    if (c.at) {
      assertEquals(res.remindAt.toISOString(), new Date(c.at).toISOString());
    }
  });
}

Deno.test("«напомни» в расписании: «каждый день в 9 напомни зарядка» → «зарядка»", () => {
  const res = parseReminder("каждый день в 9 напомни зарядка", OPTS);
  if (!res.ok) throw new Error(res.reason);
  assertEquals(res.text, "зарядка");
  assertEquals(res.rrule, "FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
});

Deno.test("одно только «напомни» без текста → нужен текст (empty_text)", () => {
  assertEquals(parseReminder("завтра в 9 напомни", OPTS), {
    ok: false,
    reason: "empty_text",
  });
});
