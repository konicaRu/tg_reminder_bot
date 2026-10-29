// Отправка сообщения через Telegram Bot API напрямую (без grammY): функции tick она нужна
// только для одного вызова, а лишняя библиотека замедлила бы запуск функции.
//
// Адрес запроса содержит токен бота: https://api.telegram.org/bot<ТОКЕН>/sendMessage.
// Токен — пароль бота. Ошибки сети в Deno содержат этот адрес целиком, а ошибки попадают в логи.
// Поэтому здесь все ошибки «чистятся»: наружу выходит только то, что токен не раскрывает.

const TIMEOUT_MS = 10_000;

// Отправляет HTML-сообщение и возвращает id отправленного сообщения (message_id).
// При любой неудаче бросает Error без токена в тексте.
export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  let response: Response;
  try {
    response = await fetchFn(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch {
    // Сознательно НЕ используем текст исходной ошибки: в нём адрес с токеном.
    throw new Error("Telegram: сеть недоступна или превышено время ожидания");
  }

  let data: {
    ok?: boolean;
    error_code?: number;
    description?: string;
    result?: unknown;
  };
  try {
    data = await response.json();
  } catch {
    throw new Error(`Telegram: непонятный ответ (HTTP ${response.status})`);
  }

  if (!response.ok || !data.ok) {
    const code = data.error_code ?? response.status;
    throw new Error(
      `Telegram: ${code} ${data.description ?? "ошибка без описания"}`,
    );
  }

  const messageId = (data.result as { message_id?: unknown } | undefined)
    ?.message_id;
  if (typeof messageId !== "number") {
    throw new Error("Telegram: в ответе нет message_id");
  }
  return messageId;
}
