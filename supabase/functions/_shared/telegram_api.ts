// Прямые вызовы Telegram Bot API (без grammY): функциям tick и set-webhook они нужны
// только в паре мест, а лишняя библиотека замедлила бы их запуск.
//
// Адрес запроса содержит токен бота: https://api.telegram.org/bot<ТОКЕН>/<метод>.
// Токен — пароль бота. Ошибки сети в Deno содержат этот адрес целиком, а ошибки попадают в логи.
// Поэтому здесь все ошибки «чистятся»: наружу выходит только то, что токен не раскрывает.

import type { Attachment, InlineKeyboardMarkup } from "./telegram.ts";

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
// replyMarkup — необязательные inline-кнопки под сообщением.
export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  fetchFn: typeof fetch = fetch,
  replyMarkup?: InlineKeyboardMarkup,
): Promise<number> {
  const result = await callTelegramApi(
    token,
    "sendMessage",
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
    fetchFn,
  );
  const messageId = (result as { message_id?: unknown } | undefined)
    ?.message_id;
  if (typeof messageId !== "number") {
    throw new Error("Telegram: в ответе нет message_id");
  }
  return messageId;
}

// Убирает кнопки у уже отправленного сообщения (текст остаётся). Нужна, чтобы у цепочки
// повторных напоминаний кнопка «Готово» была только у самого свежего сообщения.
// При ошибке (например, сообщение удалено) бросает исключение: вызывающий решает, важно ли это.
export async function clearInlineKeyboard(
  token: string,
  chatId: number,
  messageId: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await callTelegramApi(
    token,
    "editMessageReplyMarkup",
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    },
    fetchFn,
  );
}

// Скачивает файл из Telegram (например, голосовое) и возвращает его байты.
// Два шага: getFile («где лежит файл») → загрузка по адресу с токеном. Как и везде здесь,
// тексты ошибок не содержат токен: адрес с ним есть в исходных ошибках сети.
// maxBytes — защита от огромных файлов: проверяем и заявленный размер, и реально полученный.
export async function downloadTelegramFile(
  token: string,
  fileId: string,
  opts: { maxBytes: number },
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> {
  const tooBig = () => new Error("Telegram: файл слишком большой");
  const info =
    (await callTelegramApi(token, "getFile", { file_id: fileId }, fetchFn)) as
      | { file_path?: string; file_size?: number }
      | undefined;
  if (!info?.file_path) throw new Error("Telegram: в ответе нет file_path");
  if (typeof info.file_size === "number" && info.file_size > opts.maxBytes) {
    throw tooBig();
  }

  let response: Response;
  try {
    response = await fetchFn(
      `https://api.telegram.org/file/bot${token}/${info.file_path}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
  } catch {
    throw new Error(
      "Telegram: не удалось скачать файл (сеть или время ожидания)",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Telegram: скачивание файла не удалось (HTTP ${response.status})`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new Error("Telegram: файл скачался не полностью");
  }
  if (bytes.length > opts.maxBytes) throw tooBig();
  return bytes;
}

// Отправляет фото или документ по file_id (файл уже лежит в Telegram: скачивать его не нужно)
// с подписью (HTML) и необязательными кнопками. Возвращает id отправленного сообщения.
// Если файл больше недоступен, Telegram отвечает ошибкой 400: вызывающий решает, что делать.
export async function sendTelegramMedia(
  token: string,
  chatId: number,
  attachment: Attachment,
  caption: string,
  replyMarkup?: InlineKeyboardMarkup,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const isPhoto = attachment.type === "photo";
  const result = await callTelegramApi(
    token,
    isPhoto ? "sendPhoto" : "sendDocument",
    {
      chat_id: chatId,
      [isPhoto ? "photo" : "document"]: attachment.fileId,
      caption,
      parse_mode: "HTML",
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    },
    fetchFn,
  );
  const messageId = (result as { message_id?: unknown } | undefined)
    ?.message_id;
  if (typeof messageId !== "number") {
    throw new Error("Telegram: в ответе нет message_id");
  }
  return messageId;
}
