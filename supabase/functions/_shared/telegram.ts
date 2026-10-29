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
import { describeRrule } from "./repeat.ts";

// --- Типы кнопок -------------------------------------------------------------
// Inline-кнопка — кнопка прямо под сообщением. Когда её нажимают, Telegram присылает боту
// «callback query» (событие нажатия) с тем, что мы записали в callback_data.
export type InlineButton = { text: string; callback_data: string };
export type InlineKeyboardMarkup = { inline_keyboard: InlineButton[][] };

// Что делает кнопка:
//   ok    — подтвердить черновик          other — выбрать другое время
//   del   — удалить напоминание из /list  done  — «Готово»: остановить повторы
//   rep   — включить/выключить повтор     ivl   — выбрать интервал повтора (минуты)
//   cnt   — выбрать, сколько всего сообщений в серии повторов
//   edit  — открыть меню правки напоминания из /list
//   etxt  — править текст     etime — править время
//   list  — вернуться к списку
//   snz   — отложить сработавшее напоминание (минуты; 1440 = «завтра»)
//   stop  — прекратить повторы по расписанию
//   dtxt  — править текст на карточке подтверждения (до «OK»)
export type CallbackAction =
  | "ok"
  | "other"
  | "del"
  | "done"
  | "rep"
  | "ivl"
  | "cnt"
  | "edit"
  | "etxt"
  | "etime"
  | "list"
  | "dtxt"
  | "snz"
  | "stop";

// «Настойчивое» напоминание: повторять каждые intervalMin минут, всего total сообщений
// (считая первое), пока пользователь не нажмёт «Готово».
export type Nag = { intervalMin: number; total: number };

// Что предлагаем на кнопках и что берём по умолчанию.
export const NAG_INTERVALS = [5, 10, 30, 60]; // минуты
export const NAG_COUNTS = [3, 5, 10, 20]; // всего сообщений
export const DEFAULT_NAG: Nag = { intervalMin: 5, total: 10 };

// Минимум полей напоминания, который нужен для списка.
export type ListItem = {
  id: string;
  text: string;
  remind_at: string;
  nag_interval_min?: number | null;
  nag_total?: number | null;
  nag_sent?: number;
  rrule?: string | null; // расписание («по будням в 09:00»), если напоминание повторяется
};

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

// Интервал для человека: 5 → «5 мин», 60 → «1 час», 120 → «2 ч».
function formatInterval(minutes: number): string {
  if (minutes === 60) return "1 час";
  if (minutes > 60 && minutes % 60 === 0) return `${minutes / 60} ч`;
  return `${minutes} мин`;
}

// «3 раза», но «5 раз», «10 раз», «11 раз», «22 раза».
function formatTimes(n: number): string {
  const lastTwo = n % 100;
  const last = n % 10;
  const few = last >= 2 && last <= 4 && !(lastTwo >= 12 && lastTwo <= 14);
  return `${n} ${few ? "раза" : "раз"}`;
}

// Серия повторов словами: «каждые 5 мин, всего 10 раз».
export function describeNag(nag: Nag): string {
  return `каждые ${formatInterval(nag.intervalMin)}, всего ${
    formatTimes(nag.total)
  }`;
}

// --- Данные кнопок (callback_data) -------------------------------------------
// В callback_data Telegram разрешает только строку до 64 байт, поэтому пакуем так:
// «действие:идентификатор» («ok:a1b2c3d4», «del:<uuid>») или, если нужно число,
// «действие:идентификатор:число» («ivl:a1b2c3d4:30»).

export function encodeCallback(
  c: { action: CallbackAction; id: string; arg?: number },
): string {
  return c.arg === undefined
    ? `${c.action}:${c.id}`
    : `${c.action}:${c.id}:${c.arg}`;
}

// Обратно: из строки в {действие, id, число}. Всё, что не похоже на наш формат, → null.
// Это защита: callback_data приходит извне, и верить ей вслепую нельзя.
export function decodeCallback(
  data: string,
): { action: CallbackAction; id: string; arg?: number } | null {
  const plain =
    /^(ok|other|del|done|rep|edit|etxt|etime|list|dtxt|stop):([A-Za-z0-9_-]{1,60})$/
      .exec(
        data,
      );
  if (plain) return { action: plain[1] as CallbackAction, id: plain[2] };
  const withArg = /^(ivl|cnt|snz):([A-Za-z0-9_-]{1,50}):(\d{1,4})$/.exec(data);
  if (withArg) {
    return {
      action: withArg[1] as CallbackAction,
      id: withArg[2],
      arg: Number(withArg[3]),
    };
  }
  return null;
}

// «🎙 Я услышал: «…»» с переводом строки: что распознал бот в голосовом (экранировано).
export function heardLine(heard: string): string {
  return `🎙 Я услышал: «${escapeHtml(heard)}»\n`;
}

// --- Карточка подтверждения --------------------------------------------------
// Ничего не сохраняется в базу, пока пользователь не нажмёт «✅ OK»: так ошибка разбора даты
// не превращается в пропущенную встречу. draftId — короткий код черновика: нужен, чтобы кнопки
// старой карточки не подтвердили чужой, более новый черновик.
// Если nag задан, карточка показывает настройки повтора и кнопки их изменения.
export function buildConfirmCard(a: {
  text: string;
  remindAt: Date;
  draftId: string;
  timezone: string;
  now: Date;
  adjusted?: "tomorrow";
  nag?: Nag | null;
  rrule?: string | null; // расписание повторов, если есть
  heard?: string; // распознанный текст голосового: показываем первой строкой
}): { text: string; reply_markup: InlineKeyboardMarkup } {
  const when = formatWhen(a.remindAt, a.timezone, a.now);
  const note = a.adjusted === "tomorrow"
    ? "Это время сегодня уже прошло, поэтому предлагаю завтра.\n"
    : "";
  const cb = (action: CallbackAction, arg?: number) =>
    encodeCallback({ action, id: a.draftId, arg });

  const heard = a.heard !== undefined ? heardLine(a.heard) : "";
  let text = `${heard}${note}Напомню <b>${when}</b>: ${escapeHtml(a.text)}`;
  if (a.rrule) text += `\n📆 Повторяется ${describeRrule(a.rrule)}`;
  const rows: InlineButton[][] = [[
    { text: "✅ OK", callback_data: cb("ok") },
    { text: "🕐 Другое время", callback_data: cb("other") },
  ]];

  if (!a.nag) {
    rows.push([
      { text: "🔁 Повторять", callback_data: cb("rep") },
      { text: "✏️ Текст", callback_data: cb("dtxt") },
    ]);
  } else {
    const nag = a.nag;
    text += `\n🔁 Повторю ${describeNag(nag)}, пока не нажмёшь «Готово»`;
    rows.push([
      { text: "🔁 Выключить повтор", callback_data: cb("rep") },
      { text: "✏️ Текст", callback_data: cb("dtxt") },
    ]);
    // Отметка ✓ стоит у выбранного значения.
    rows.push(NAG_INTERVALS.map((m) => ({
      text: `${formatInterval(m)}${m === nag.intervalMin ? " ✓" : ""}`,
      callback_data: cb("ivl", m),
    })));
    rows.push(NAG_COUNTS.map((n) => ({
      text: `×${n}${n === nag.total ? " ✓" : ""}`,
      callback_data: cb("cnt", n),
    })));
  }
  return { text, reply_markup: { inline_keyboard: rows } };
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
  const lines = shown.map((it, i) => {
    let line = `${i + 1}. ${formatWhen(new Date(it.remind_at), tz, now)} — ${
      escapeHtml(it.text)
    }`;
    if (it.rrule) line += ` 📆 ${describeRrule(it.rrule)}`;
    // У напоминаний с повтором — отметка 🔁 и сколько сообщений серии уже ушло.
    if (it.nag_interval_min && it.nag_total) {
      line += ` 🔁 каждые ${
        formatInterval(it.nag_interval_min)
      } ×${it.nag_total}`;
      if (it.nag_sent) line += ` (отправлено ${it.nag_sent})`;
    }
    return line;
  });
  let text = `Твои напоминания:\n${lines.join("\n")}`;
  if (items.length > shown.length) {
    text += `\n\nПоказаны ближайшие ${shown.length} из ${items.length}.`;
  }

  // Под списком — кнопки «✏️ 1»… (править) и «🗑 1»… (удалить): номер = строка списка.
  const rows: InlineButton[][] = [];
  for (const [icon, action] of [["✏️", "edit"], ["🗑", "del"]] as const) {
    const buttons: InlineButton[] = shown.map((it, i) => ({
      text: `${icon} ${i + 1}`,
      callback_data: encodeCallback({ action, id: it.id }),
    }));
    for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
      rows.push(buttons.slice(i, i + BUTTONS_PER_ROW));
    }
  }
  return { text, reply_markup: { inline_keyboard: rows } };
}

// --- Меню правки одного напоминания ------------------------------------------
export function buildEditMenu(
  item: ListItem,
  tz: string,
  now: Date,
): { text: string; reply_markup: InlineKeyboardMarkup } {
  const when = formatWhen(new Date(item.remind_at), tz, now);
  return {
    text: `Что изменить?\n${when} — ${escapeHtml(item.text)}`,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "✏️ Текст",
            callback_data: encodeCallback({ action: "etxt", id: item.id }),
          },
          {
            text: "🕐 Время",
            callback_data: encodeCallback({ action: "etime", id: item.id }),
          },
        ],
        [{
          text: "⬅️ К списку",
          callback_data: encodeCallback({ action: "list", id: "all" }),
        }],
      ],
    },
  };
}

// --- Сообщение, когда напоминание сработало ----------------------------------
// Для серии повторов в заголовке «(2 из 10)».
export function buildReminderMessage(
  text: string,
  progress?: { index: number; total: number },
): string {
  const counter = progress ? ` (${progress.index} из ${progress.total})` : "";
  return `⏰ <b>Напоминание</b>${counter}\n${escapeHtml(text)}`;
}

// Значения snooze на кнопках: минуты; SNOOZE_TOMORROW = «завтра в время по умолчанию».
export const SNOOZE_TOMORROW = 1440;
export const SNOOZE_OPTIONS = [10, 60, SNOOZE_TOMORROW];

// Кнопки под сработавшим напоминанием: отложить или «Готово» (останавливает серию повторов).
export function buildReminderKeyboard(
  reminderId: string,
  opts: { repeating?: boolean } = {},
): InlineKeyboardMarkup {
  const snz = (arg: number, text: string): InlineButton => ({
    text,
    callback_data: encodeCallback({ action: "snz", id: reminderId, arg }),
  });
  return {
    inline_keyboard: [
      [snz(10, "+10 мин"), snz(60, "+1 час"), snz(SNOOZE_TOMORROW, "Завтра")],
      [
        {
          text: "✅ Готово",
          callback_data: encodeCallback({ action: "done", id: reminderId }),
        },
        // У напоминания по расписанию «Готово» закрывает только это срабатывание,
        // а закончить всё расписание можно отдельной кнопкой.
        ...(opts.repeating
          ? [{
            text: "⛔ Прекратить повторы",
            callback_data: encodeCallback({ action: "stop", id: reminderId }),
          }]
          : []),
      ],
    ],
  };
}

// Во что превращается сообщение после snooze («when» уже отформатировано для человека).
export function buildSnoozedMessage(text: string, when: string): string {
  return `💤 <b>Отложено до ${when}</b>\n${escapeHtml(text)}`;
}

// Во что превращается сообщение после «⛔ Прекратить повторы».
export function buildSeriesStoppedMessage(text: string): string {
  return `⛔ <b>Повторы прекращены</b>\n${escapeHtml(text)}`;
}

// Во что превращается сообщение после нажатия «Готово».
export function buildStoppedMessage(text: string): string {
  return `✅ <b>Готово</b>\n${escapeHtml(text)}`;
}
