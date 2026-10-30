// Общее для всех «запасных» разборов через нейросеть (Groq, Gemini): инструкция для модели
// и проверка её ответа. Ответ модели НЕ берём на веру: проверяем форму, дату и уверенность.
// Любая странность → вежливый отказ, а не неверное напоминание.

import type {
  ParseFailReason,
  ParseOptions,
  ParseResult,
} from "./parser/mod.ts";
import { addDays, localParts, offsetString, zonedToUtc } from "./parser/tz.ts";
import { buildRrule, nextOccurrence, parseRrule } from "./repeat.ts";

const MIN_CONFIDENCE = 0.5; // ниже — лучше попросить уточнить, чем угадывать

// Дата строго с поясом: «…+03:00» или «…Z». Без пояса её нельзя однозначно перевести в UTC.
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export const fail = (reason: ParseFailReason): ParseResult => ({
  ok: false,
  reason,
});

// Инструкция для модели. «Сейчас» и пояс нужны, чтобы она правильно считала «завтра», «в четверг».
export function buildSystemPrompt(opts: ParseOptions): string {
  const { now, timezone: tz } = opts;
  const p = localParts(now, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = offsetString(now, tz);
  const localIso = `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${
    pad(p.s)
  }${offset}`;
  // Пример для модели, посчитанный от настоящего «сейчас»: «через 2 дня в 13:00» (в поясе пользователя).
  const inTwoDays = addDays({ y: p.y, m: p.m, d: p.d }, 2);
  const exampleIso = `${inTwoDays.y}-${pad(inTwoDays.m)}-${
    pad(inTwoDays.d)
  }T13:00:00${
    offsetString(
      zonedToUtc(inTwoDays.y, inTwoDays.m, inTwoDays.d, 13, 0, tz),
      tz,
    )
  }`;
  const weekday = new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    weekday: "long",
  }).format(now);

  return [
    "Ты разбираешь фразу пользователя в напоминание.",
    'Верни ТОЛЬКО JSON-объект вида {"text": строка, "remind_at": строка, "rrule": null, "confidence": число}.',
    "- text: о чём напомнить, без указания даты и времени, на языке пользователя.",
    `- remind_at: момент напоминания в формате ISO 8601 со смещением пояса пользователя (${offset}), например 2026-10-29T11:00:00${offset}. Только в будущем.`,
    '- rrule: если фраза просит повтор каждый день или по дням недели, строка RRULE со временем, например "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" или "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0". Других видов повторов (раз в N недель, месяц, год) не бывает: тогда верни то, что просит фраза, в том же формате. Если повтора нет, null.',
    "- confidence: число от 0 до 1, насколько ты уверен в разборе. Если в фразе нет даты или времени, поставь 0.",
    `- Если время не указано, используй ${opts.defaultTime}.`,
    "- Размытые слова: «пара дней» = 2 дня, «пару часов» = 2 часа, «обед» = 13:00, «утром» = 09:00, «днём» = 14:00, «вечером» = 19:00, «ночью» = 23:00.",
    "- «Через N дней» считай от сегодняшней даты пользователя. remind_at не раньше текущего момента: сегодняшний день подходит, только если время ещё впереди.",
    `Пример: сейчас ${localIso}; фраза «через пару дней в обед созвон» → {"text": "созвон", "remind_at": "${exampleIso}", "rrule": null, "confidence": 0.9}.`,
    `Пояс пользователя: ${tz} (UTC${offset}). Сейчас у пользователя: ${localIso}, ${weekday}.`,
  ].join("\n");
}

// Разбирает ответ модели (строка с JSON) и проверяет его. content — то, что модель «написала».
export function interpretLlmContent(
  content: string,
  opts: ParseOptions,
): ParseResult {
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(content);
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      return fail("llm_invalid");
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return fail("llm_invalid");
  }

  // 3. Проверяем форму ответа.
  const { text, remind_at: remindAtRaw, rrule, confidence } = obj;
  if (
    typeof text !== "string" || typeof remindAtRaw !== "string" ||
    typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)
  ) {
    return fail("llm_invalid");
  }
  if (confidence < MIN_CONFIDENCE) return fail("llm_invalid");

  const cleanText = text.trim();

  // Повтор: принимаем только то, что умеем (каждый день / дни недели). Остальное честно
  // отклоняем, а не сохраняем «разовое» вместо «каждый месяц». Строку приводим к нашему
  // виду, а первое срабатывание считаем сами (дате от модели в повторе не доверяем).
  if (typeof rrule === "string" && rrule.trim() !== "") {
    const rule = parseRrule(rrule.trim());
    if (!rule) return fail("repeat_unsupported");
    if (!cleanText) return fail("empty_text");
    const normalized = buildRrule(rule);
    const first = nextOccurrence(normalized, opts.now, opts.timezone);
    if (!first) return fail("repeat_unsupported");
    return {
      ok: true,
      text: cleanText,
      remindAt: first,
      rrule: normalized,
      confidence,
    };
  }

  if (!cleanText) return fail("empty_text");

  // 4. Проверяем дату: с поясом, читается, в будущем.
  if (!ISO_WITH_OFFSET.test(remindAtRaw)) return fail("llm_invalid");
  const remindAt = new Date(remindAtRaw);
  if (Number.isNaN(remindAt.getTime())) return fail("llm_invalid");
  if (remindAt.getTime() <= opts.now.getTime()) return fail("llm_invalid");

  return { ok: true, text: cleanText, remindAt, rrule: null, confidence };
}
