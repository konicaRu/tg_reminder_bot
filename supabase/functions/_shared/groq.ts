// Запасной разбор фразы через Groq LLM: вызываем, когда правила парсера не поняли текст.
// Модель просим вернуть строгий JSON, а её ответ НЕ берём на веру: проверяем форму,
// дату и уверенность. Любая странность → вежливый отказ, а не неверное напоминание.
//
// STT (голос → текст через Whisper) появится в фазе 4, здесь его нет.

import type { ParseOptions, ParseResult } from "./parser/mod.ts";
import { buildSystemPrompt, fail, interpretLlmContent } from "./llm_common.ts";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TIMEOUT_MS = 8000; // дольше ждать нет смысла: пользователь ждёт карточку

export type GroqConfig = {
  apiKey: string;
  model: string; // из секрета GROQ_LLM_MODEL
  fetchFn?: typeof fetch; // в тестах подставляем «фальшивый» fetch
};

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

  return interpretLlmContent(content, opts);
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
