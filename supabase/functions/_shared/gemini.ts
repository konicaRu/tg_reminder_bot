// Запасной разбор фразы через Google Gemini: подключаем, когда основная модель (Groq) недоступна.
// Инструкция для модели и проверка её ответа общие с Groq (см. llm_common.ts): ответ нейросети
// мы не берём на веру ни здесь, ни там.
//
// Ключ передаём в заголовке x-goog-api-key, а не в адресе: адреса попадают в логи и ошибки сети.

import type { ParseOptions, ParseResult } from "./parser/mod.ts";
import { buildSystemPrompt, fail, interpretLlmContent } from "./llm_common.ts";

const API = "https://generativelanguage.googleapis.com/v1beta/models";
const TIMEOUT_MS = 8000; // как у Groq: пользователь ждёт карточку

export type GeminiConfig = {
  apiKey: string;
  model: string; // например, gemini-3.5-flash-lite
  fetchFn?: typeof fetch; // в тестах подставляем «фальшивый» fetch
};

export async function parseWithGemini(
  input: string,
  opts: ParseOptions,
  cfg: GeminiConfig,
): Promise<ParseResult> {
  const fetchFn = cfg.fetchFn ?? fetch;

  // 1. Запрос. Сеть, лимиты, блокировка региона, ошибка сервера → «модель недоступна».
  let response: Response;
  try {
    response = await fetchFn(
      `${API}/${encodeURIComponent(cfg.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": cfg.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildSystemPrompt(opts) }] },
          contents: [{ role: "user", parts: [{ text: input }] }],
          generationConfig: {
            temperature: 0, // нужен стабильный разбор, а не «творчество»
            responseMimeType: "application/json",
            maxOutputTokens: 1500,
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    return fail("llm_unavailable");
  }
  if (!response.ok) return fail("llm_unavailable");

  // 2. Достаём текст ответа: части с пометкой thought — это «рассуждения» модели, их пропускаем.
  let content = "";
  try {
    const data = await response.json();
    const parts: { text?: unknown; thought?: unknown }[] =
      data?.candidates?.[0]?.content?.parts ?? [];
    content = parts
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  } catch {
    return fail("llm_invalid");
  }
  if (!content.trim()) return fail("llm_invalid"); // заблокировано или пусто

  return interpretLlmContent(content, opts);
}
