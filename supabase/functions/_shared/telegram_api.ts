// Прямые вызовы Telegram Bot API (без grammY): функциям tick и set-webhook они нужны
// только в паре мест, а лишняя библиотека замедлила бы их запуск.
//
// Адрес запроса содержит токен бота: https://api.telegram.org/bot<ТОКЕН>/<метод>.
// Токен — пароль бота. Ошибки сети в Deno содержат этот адрес целиком, а ошибки попадают в логи.
// Поэтому здесь все ошибки «чистятся»: наружу выходит только то, что токен не раскрывает.

const TIMEOUT_MS = 10_000;

// Вызывает любой метод Bot API (sendMessage, setWebhook, getWebhookInfo…) и возвращает поле result.
// При любой неудаче бросает Error без токена в тексте.
export async function callTelegramApi(
  token: string,
  method: string,
  payload: Record<string, unknown>,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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
  return data.result;
}

// Отправляет HTML-сообщение и возвращает id отправленного сообщения (message_id).
export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const result = await callTelegramApi(
    token,
    "sendMessage",
    { chat_id: chatId, text, parse_mode: "HTML" },
    fetchFn,
  );
  const messageId = (result as { message_id?: unknown } | undefined)
    ?.message_id;
  if (typeof messageId !== "number") {
    throw new Error("Telegram: в ответе нет message_id");
  }
  return messageId;
}
