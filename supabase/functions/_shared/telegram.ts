// Хелперы для общения с Telegram: как бот показывает даты, карточку подтверждения,
// список напоминаний и как «запаковывает» данные кнопок.
//
// Все функции здесь «чистые»: не ходят в сеть и в базу, на один и тот же вход всегда дают
// один и тот же результат. Поэтому их легко проверять тестами.
//
// Тексты сообщений бот отправляет с parse_mode = "HTML": так можно делать <b>жирный</b>.
// Цена вопроса — любой текст пользователя нужно «экранировать» (см. escapeHtml), иначе
// символы < > & в его тексте сломают разметку или Telegram отклонит сообщение.

import { localParts } from "./parser/tz.ts";

// --- Типы кнопок -------------------------------------------------------------
// Inline-кнопка — кнопка прямо под сообщением. Когда её нажимают, Telegram присылает боту
// «callback query» (событие нажатия) с тем, что мы записали в callback_data.
export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboardMarkup = { inline_keyboard: InlineButton[][] };

// Что делает кнопка: подтвердить черновик / выбрать другое время / удалить напоминание.
export type CallbackAction = "ok" | "other" | "del";

// Минимум полей напоминания, который нужен для списка.
export type ListItem = { id: string; text: string; remind_at: string };

const MAX_LIST_ITEMS = 20; // в одном сообщении показываем не больше 20 напоминаний
const BUTTONS_PER_ROW = 5; // кнопок 🗑 в одном ряду

// --- Форматирование ----------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, "0");

// Дата и время «для человека» в поясе пользователя: «29.10 в 11:00».
// Год добавляем, только если он отличается от текущего: «03.10.2027 в 09:00».
export function formatWhen(date: Date, tz: string, now: Date): string {
  const p = localParts(date, tz);
  const nowYear = localParts(now, tz).y;
  const year = p.y === nowYear ? "" : `.${p.y}`;
  return `${pad2(p.d)}.${pad2(p.m)}${year} в ${pad2(p.h)}:${pad2(p.mi)}`;
}

// Экранирование HTML: заменяем три «опасных» символа на безопасные коды.
// «a < b» → «a &lt; b». Telegram покажет пользователю обычное «a < b».
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}

// --- Данные кнопок (callback_data) -------------------------------------------
// В callback_data Telegram разрешает только строку до 64 байт, поэтому пакуем так:
// «действие:идентификатор», например «ok:a1b2c3d4» или «del:<uuid>».

export function encodeCallback(
  c: { action: CallbackAction; id: string },
): string {
  return `${c.action}:${c.id}`;
}

// Обратно: из строки в {действие, id}. Всё, что не похоже на наш формат, → null.
// Это защита: callback_data приходит извне, и верить ей вслепую нельзя.
export function decodeCallback(
  data: string,
): { action: CallbackAction; id: string } | null {
  const m = /^(ok|other|del):([A-Za-z0-9_-]{1,60})$/.exec(data);
  return m ? { action: m[1] as CallbackAction, id: m[2] } : null;
}

// --- Карточка подтверждения --------------------------------------------------
// Ничего не сохраняется в базу, пока пользователь не нажмёт «✅ OK»: так ошибка разбора даты
// не превращается в пропущенную встречу. draftId — короткий код черновика: нужен, чтобы кнопки
// старой карточки не подтвердили чужой, более новый черновик.
export function buildConfirmCard(a: {
  text: string;
  remindAt: Date;
  draftId: string;
  timezone: string;
  now: Date;
  adjusted?: "tomorrow";
}): { text: string; reply_markup: InlineKeyboardMarkup } {
  const when = formatWhen(a.remindAt, a.timezone, a.now);
  const note = a.adjusted === "tomorrow"
    ? "Это время сегодня уже прошло, поэтому предлагаю завтра.\n"
    : "";
  return {
    text: `${note}Напомню <b>${when}</b>: ${escapeHtml(a.text)}`,
    reply_markup: {
      inline_keyboard: [[
        {
          text: "✅ OK",
          callback_data: encodeCallback({ action: "ok", id: a.draftId }),
        },
        {
          text: "🕐 Другое время",
          callback_data: encodeCallback({ action: "other", id: a.draftId }),
        },
      ]],
    },
  };
}

// --- Список напоминаний (/list) ----------------------------------------------
// Ожидаем, что items уже отсортированы по времени (это делает запрос к базе).
export function buildListMessage(
  items: ListItem[],
  tz: string,
  now: Date,
): { text: string; reply_markup?: InlineKeyboardMarkup } {
  if (items.length === 0) return { text: "Напоминаний пока нет." };

  const shown = items.slice(0, MAX_LIST_ITEMS);
  const lines = shown.map((it, i) =>
    `${i + 1}. ${formatWhen(new Date(it.remind_at), tz, now)} — ${
      escapeHtml(it.text)
    }`
  );
  let text = `Твои напоминания:\n${lines.join("\n")}`;
  if (items.length > shown.length) {
    text += `\n\nПоказаны ближайшие ${shown.length} из ${items.length}.`;
  }

  // Под списком — кнопки «🗑 1», «🗑 2»…: номер соответствует строке списка.
  const buttons: InlineButton[] = shown.map((it, i) => ({
    text: `🗑 ${i + 1}`,
    callback_data: encodeCallback({ action: "del", id: it.id }),
  }));
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(buttons.slice(i, i + BUTTONS_PER_ROW));
  }
  return { text, reply_markup: { inline_keyboard: rows } };
}

// --- Сообщение, когда напоминание сработало ----------------------------------
export function buildReminderMessage(text: string): string {
  return `⏰ <b>Напоминание</b>\n${escapeHtml(text)}`;
}
