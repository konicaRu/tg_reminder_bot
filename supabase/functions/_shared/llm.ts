// Цепочка «основная нейросеть → запасная» для разбора фраз.
//
// Запасную зовём ТОЛЬКО когда основная недоступна (сбой, лимит, сеть). Если основная ответила,
// пусть даже «не понял», это и есть ответ: так мы не гоняем лишние запросы и не отправляем
// личные фразы во второй сервис без необходимости.

import type { ParseOptions, ParseResult } from "./parser/mod.ts";

export type LlmParse = (
  input: string,
  opts: ParseOptions,
) => Promise<ParseResult>;

const UNAVAILABLE: ParseResult = { ok: false, reason: "llm_unavailable" };

// Любую неожиданную ошибку модели считаем «недоступна»: бот не должен падать из-за резерва.
async function safely(fn: LlmParse, input: string, opts: ParseOptions) {
  try {
    return await fn(input, opts);
  } catch {
    return UNAVAILABLE;
  }
}

// Собирает цепочку. Если настроена только одна модель, возвращает её; если ни одной, undefined.
// onFallback вызывается при переключении (для лога; текст фразы ему не передаём).
export function withFallback(
  primary: LlmParse | undefined,
  secondary: LlmParse | undefined,
  onFallback?: () => void,
): LlmParse | undefined {
  if (!primary) return secondary;
  if (!secondary) return primary;
  return async (input, opts) => {
    const first = await safely(primary, input, opts);
    if (first.ok || first.reason !== "llm_unavailable") return first;
    onFallback?.();
    return await safely(secondary, input, opts);
  };
}
