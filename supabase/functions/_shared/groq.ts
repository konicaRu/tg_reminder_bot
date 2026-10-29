// Запасной разбор фразы через Groq LLM: вызываем, когда правила парсера не поняли текст.
// Модель просим вернуть строгий JSON, а её ответ НЕ берём на веру: проверяем форму,
// дату и уверенность. Любая странность → вежливый отказ, а не неверное напоминание.
//
// STT (голос → текст через Whisper) появится в фазе 4, здесь его нет.

import type {
  ParseFailReason,
  ParseOptions,
  ParseResult,
} from "./parser/mod.ts";
import { localParts, offsetString } from "./parser/tz.ts";
import { buildRrule, nextOccurrence, parseRrule } from "./repeat.ts";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TIMEOUT_MS = 8000; // дольше ждать нет смысла: пользователь ждёт карточку
const MIN_CONFIDENCE = 0.5; // ниже — лучше попросить уточнить, чем угадывать

// Дата строго с поясом: «…+03:00» или «…Z». Без пояса её нельзя однозначно перевести в UTC.
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export type GroqConfig = {
  apiKey: string;
  model: string; // из секрета GROQ_LLM_MODEL
  fetchFn?: typeof fetch; // в тестах подставляем «фальшивый» fetch
};

const fail = (reason: ParseFailReason): ParseResult => ({ ok: false, reason });

// Инструкция для модели. «Сейчас» и пояс нужны, чтобы она правильно считала «завтра», «в четверг».
function buildSystemPrompt(opts: ParseOptions): string {
  const { now, timezone: tz } = opts;
  const p = localParts(now, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = offsetString(now, tz);
  const localIso = `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${
    pad(p.s)
  }${offset}`;
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
    `Пояс пользователя: ${tz} (UTC${offset}). Сейчас у пользователя: ${localIso}, ${weekday}.`,
  ].join("\n");
}

export async function parseWithLlm(
  input: string,
  opts: ParseOptions,
  cfg: GroqConfig,
): Promise<ParseResult> {
  const fetchFn = cfg.fetchFn ?? fetch;

  // 1. Запрос к Groq. Сеть, лимиты, таймаут, ошибка сервера → «модель недоступна».
  let response: Response;
  try {
    response = await fetchFn(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0, // нужен стабильный разбор, а не «творчество»
        // Лимит ответа. «Думающие» модели (gpt-oss) тратят часть токенов на рассуждения;
        // при малом лимите до самого JSON дело не доходит и ответ приходит пустым.
        max_tokens: 1500,
        // reasoning_effort понимают только gpt-oss; другим моделям он вызвал бы ошибку 400.
        ...(cfg.model.startsWith("openai/gpt-oss")
          ? { reasoning_effort: "low" }
          : {}),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(opts) },
          { role: "user", content: input },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return fail("llm_unavailable");
  }
  if (!response.ok) return fail("llm_unavailable");

  // 2. Достаём ответ модели и разбираем JSON.
  let content: unknown;
  try {
    const data = await response.json();
    content = data?.choices?.[0]?.message?.content;
  } catch {
    return fail("llm_invalid");
  }
  if (typeof content !== "string") return fail("llm_invalid");

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

// --- Распознавание голоса (Whisper) ------------------------------------------

const GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const STT_TIMEOUT_MS = 20_000;

export type SttConfig = {
  apiKey: string;
  model: string; // например, whisper-large-v3
  fetchFn?: typeof fetch; // для тестов
};

export type SttResult =
  | { ok: true; text: string }
  // stt_unavailable: Groq не ответил (сеть, лимиты, ошибка сервера);
  // stt_empty: ответ пришёл, но слов в нём нет (тишина, шум)
  | { ok: false; reason: "stt_unavailable" | "stt_empty" };

// Голосовые сообщения Telegram — это OGG/Opus; Groq принимает такой формат как есть.
// Содержимое (аудио и распознанный текст) нигде не логируем: оно личное.
export async function transcribeAudio(
  audio: Uint8Array,
  cfg: SttConfig,
): Promise<SttResult> {
  const fetchFn = cfg.fetchFn ?? fetch;
  const form = new FormData();
  form.append(
    "file",
    new File([audio.slice().buffer as ArrayBuffer], "voice.ogg", {
      type: "audio/ogg",
    }),
  );
  form.append("model", cfg.model);
  form.append("language", "ru");
  form.append("temperature", "0");
  form.append("response_format", "json");

  let response: Response;
  try {
    response = await fetchFn(GROQ_STT_URL, {
      method: "POST",
      // Content-Type не задаём: fetch сам добавит его вместе с границей multipart
      headers: { "Authorization": `Bearer ${cfg.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(STT_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "stt_unavailable" };
  }
  if (!response.ok) return { ok: false, reason: "stt_unavailable" };

  let text: unknown;
  try {
    text = (await response.json())?.text;
  } catch {
    return { ok: false, reason: "stt_unavailable" };
  }
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, reason: "stt_empty" };
  }
  return { ok: true, text: text.trim() };
}
