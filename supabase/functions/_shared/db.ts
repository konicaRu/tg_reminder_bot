// Слой доступа к базе: все запросы бота к Postgres лежат здесь, в одном месте.
// Остальной код (bot, tick) не пишет SQL сам, а вызывает эти функции.
//
// Как мы ходим в базу: через supabase-js — библиотеку, которая превращает вызовы вида
// db.from("reminders").select() в запросы к REST-интерфейсу Supabase (PostgREST).
//
// Какой ключ используем: SERVICE ROLE — «ключ-администратор» проекта. Он обходит RLS
// (построчную защиту, которую мы включили в миграции без единой политики), поэтому ходить
// им можно только из наших функций на сервере. Никогда не отправляй его в браузер/Telegram.
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase сам подставляет в Edge Functions.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export type Db = SupabaseClient;

// Напоминание — строка таблицы reminders (поля по миграции init).
export type Reminder = {
  id: string;
  chat_id: number;
  text: string;
  remind_at: string; // ISO-строка в UTC
  rrule: string | null;
  status: "pending" | "sending" | "sent" | "done" | "cancelled";
  attachment_file_id: string | null;
  attachment_type: "photo" | "document" | "voice" | null;
  last_message_id: number | null;
  // «Настойчивое» напоминание (серия повторов, пока не нажмут «Готово»).
  // nag_interval_min = null означает обычное напоминание без повторов.
  nag_interval_min: number | null; // через сколько минут слать следующий повтор
  nag_total: number | null; // сколько всего сообщений в серии, считая первое
  nag_sent: number; // сколько сообщений серии уже отправлено
  created_at: string;
  updated_at: string;
};

export type Settings = { timezone: string; default_time: string }; // default_time: «HH:MM»
export type Session = { state: string; payload: Record<string, unknown> };

// Если у пользователя ещё нет строки в settings, пользуемся этими значениями.
export const DEFAULT_SETTINGS: Settings = {
  timezone: "Europe/Moscow",
  default_time: "09:00",
};

// Если запрос не удался, выбрасываем понятную ошибку: вызывающий код решит, что делать.
function check<T>(
  res: { data: T; error: { message: string } | null },
  what: string,
): T {
  if (res.error) throw new Error(`БД: ${what}: ${res.error.message}`);
  return res.data;
}

export function createDb(): Db {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Нет SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY");
  }
  // Состояние сессий хранить не нужно: каждый вызов функции — «с чистого листа».
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// --- Настройки пользователя --------------------------------------------------

export async function getSettings(db: Db, chatId: number): Promise<Settings> {
  const row = check(
    await db.from("settings").select("timezone, default_time").eq(
      "chat_id",
      chatId,
    )
      .maybeSingle(),
    "чтение настроек",
  );
  if (!row) return DEFAULT_SETTINGS;
  // Postgres отдаёт время как «09:00:00», нам нужно «09:00».
  return {
    timezone: row.timezone,
    default_time: String(row.default_time).slice(0, 5),
  };
}

// --- Состояние диалога (таблица sessions) ------------------------------------
// Функции «ничего не помнят» между запросами, поэтому «бот ждёт от тебя новое время»
// записывается в базу. На один чат — одна строка: новое состояние заменяет старое.

export async function getSession(
  db: Db,
  chatId: number,
): Promise<Session | null> {
  const row = check(
    await db.from("sessions").select("state, payload").eq("chat_id", chatId)
      .maybeSingle(),
    "чтение сессии",
  );
  return row ? { state: row.state, payload: row.payload ?? {} } : null;
}

// upsert = «вставь строку, а если такая уже есть — обнови».
export async function setSession(
  db: Db,
  chatId: number,
  state: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  check(
    await db.from("sessions").upsert({
      chat_id: chatId,
      state,
      payload,
      updated_at: new Date().toISOString(),
    }),
    "запись сессии",
  );
}

export async function clearSession(db: Db, chatId: number): Promise<void> {
  check(
    await db.from("sessions").delete().eq("chat_id", chatId),
    "очистка сессии",
  );
}

// --- Напоминания -------------------------------------------------------------

export async function createReminder(
  db: Db,
  r: {
    chat_id: number;
    text: string;
    remind_at: Date;
    rrule?: string | null;
    // повторять каждые intervalMin минут, всего total сообщений (см. миграцию nag_repeat)
    nag?: { intervalMin: number; total: number } | null;
    // приложенное фото/документ: храним только file_id (файл лежит в Telegram)
    attachment?: { type: "photo" | "document"; fileId: string } | null;
  },
): Promise<Reminder> {
  return check(
    await db.from("reminders").insert({
      chat_id: r.chat_id,
      text: r.text,
      remind_at: r.remind_at.toISOString(),
      rrule: r.rrule ?? null,
      nag_interval_min: r.nag?.intervalMin ?? null,
      nag_total: r.nag?.total ?? null,
      attachment_file_id: r.attachment?.fileId ?? null,
      attachment_type: r.attachment?.type ?? null,
    }).select().single(),
    "создание напоминания",
  ) as Reminder;
}

// Будущие (ещё не сработавшие) напоминания чата, ближайшие первыми.
export async function listPendingReminders(
  db: Db,
  chatId: number,
  limit = 50,
): Promise<Reminder[]> {
  return check(
    await db.from("reminders").select().eq("chat_id", chatId).eq(
      "status",
      "pending",
    )
      .order("remind_at", { ascending: true }).limit(limit),
    "список напоминаний",
  ) as Reminder[];
}

// Одно ожидающее напоминание своего чата (для правки) или null, если его уже нет
// (сработало, удалено, чужое).
export async function getReminder(
  db: Db,
  chatId: number,
  id: string,
): Promise<Reminder | null> {
  const rows = check(
    await db.from("reminders").select().eq("id", id).eq("chat_id", chatId)
      .eq("status", "pending").limit(1),
    "чтение напоминания",
  ) as Reminder[] | null;
  return rows && rows.length > 0 ? rows[0] : null;
}

// Правка текста и/или времени. Условия защищают: только свои напоминания и только пока
// статус pending (если tick уже забрал запись, правка не должна её «воскресить»).
// Смена времени обнуляет счётчик серии повторов: серия начинается заново.
// Возвращает true, если запись обновилась.
export async function updateReminder(
  db: Db,
  chatId: number,
  id: string,
  // attachment: новое вложение или null, чтобы убрать
  patch: {
    text?: string;
    remind_at?: Date;
    rrule?: string;
    attachment?: { type: "photo" | "document"; fileId: string } | null;
  },
): Promise<boolean> {
  const rows = check(
    await db.from("reminders").update({
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.rrule !== undefined ? { rrule: patch.rrule } : {}),
      ...(patch.attachment !== undefined
        ? {
          attachment_file_id: patch.attachment?.fileId ?? null,
          attachment_type: patch.attachment?.type ?? null,
        }
        : {}),
      ...(patch.remind_at
        ? { remind_at: patch.remind_at.toISOString(), nag_sent: 0 }
        : {}),
    }).eq("id", id).eq("chat_id", chatId).eq("status", "pending").select("id"),
    "правка напоминания",
  );
  return (rows?.length ?? 0) > 0;
}

// «Удаление» = перевод в статус cancelled. Строка остаётся в базе (история, можно разобраться
// «куда делось напоминание»), но tick её больше не берёт.
// Условие chat_id защищает: удалить можно только свои напоминания.
// Возвращает true, если что-то действительно отменили.
export async function cancelReminder(
  db: Db,
  chatId: number,
  id: string,
): Promise<boolean> {
  const rows = check(
    await db.from("reminders").update({ status: "cancelled" })
      .eq("id", id).eq("chat_id", chatId).eq("status", "pending").select("id"),
    "отмена напоминания",
  );
  return (rows?.length ?? 0) > 0;
}

// --- Для функции tick --------------------------------------------------------

// Если tick «упал» посреди отправки, запись навсегда осталась бы в статусе sending.
// Поэтому записи, зависшие в sending дольше этого срока, возвращаем в pending.
export const STALE_SENDING_MS = 5 * 60 * 1000;

// Атомарно забирает наступившие напоминания.
// «Атомарно» = одним неделимым запросом UPDATE … WHERE status='pending' … RETURNING.
// Если tick случайно вызвали дважды одновременно, базе приходится выполнять запросы по очереди:
// второй запрос уже не увидит записей в статусе pending и ничего не вернёт.
// Благодаря этому одно напоминание не придёт дважды (это и называется «идемпотентность»).
// Просроченные (remind_at в прошлом) тоже попадают сюда: так tick «досылает» пропущенное.
export async function claimDueReminders(db: Db): Promise<Reminder[]> {
  const staleBefore = new Date(Date.now() - STALE_SENDING_MS).toISOString();
  check(
    await db.from("reminders").update({ status: "pending" })
      .eq("status", "sending").lt("updated_at", staleBefore),
    "возврат зависших напоминаний",
  );
  const rows = check(
    await db.from("reminders").update({ status: "sending" })
      .eq("status", "pending").lte("remind_at", new Date().toISOString())
      .select(),
    "захват наступивших напоминаний",
  ) as Reminder[];
  return rows.sort((a, b) => a.remind_at.localeCompare(b.remind_at));
}

// Отправили успешно: запоминаем id сообщения (понадобится для кнопок snooze в фазе 2).
// Для серии повторов: nagSent — сколько сообщений серии теперь отправлено, nextRemindAt —
// когда слать следующее (если не задано, серия закончена и напоминание становится sent).
//
// Обновление УСЛОВНОЕ (только пока статус sending): если пользователь за время отправки
// успел нажать «Готово» (done) или 🗑 (cancelled), его решение остаётся в силе, а повтор
// не возобновляется. Возвращает true, если запись обновилась, false, если пользователь опередил.
export async function markReminderSent(
  db: Db,
  id: string,
  messageId: number,
  next: { nagSent?: number; nextRemindAt?: Date } = {},
): Promise<boolean> {
  const rows = check(
    await db.from("reminders").update({
      status: next.nextRemindAt ? "pending" : "sent",
      last_message_id: messageId,
      ...(next.nagSent !== undefined ? { nag_sent: next.nagSent } : {}),
      ...(next.nextRemindAt
        ? { remind_at: next.nextRemindAt.toISOString() }
        : {}),
    }).eq("id", id).eq("status", "sending").select("id"),
    "отметка «отправлено»",
  );
  return (rows?.length ?? 0) > 0;
}

// «Готово»: останавливает напоминание (и серию повторов). Работает, пока оно не отменено:
// в ожидании, в момент отправки или уже отправлено. Условие chat_id защищает от чужих.
// Возвращает текст напоминания (чтобы показать «✅ Готово: …») или null, если останавливать
// нечего (уже остановлено, отменено, чужое).
export async function stopReminder(
  db: Db,
  chatId: number,
  id: string,
): Promise<{ text: string } | null> {
  const rows = check(
    await db.from("reminders").update({ status: "done" })
      .eq("id", id).eq("chat_id", chatId).in("status", [
        "pending",
        "sending",
        "sent",
      ])
      .select("text"),
    "остановка напоминания",
  );
  return rows && rows.length > 0 ? { text: rows[0].text as string } : null;
}

// «Готово». Если у напоминания есть расписание (rrule), закрывается только это срабатывание:
// запись возвращается в pending на следующее время (его считает nextFor), серия повторов
// «каждые N минут» обнуляется. Без расписания работает как stopReminder (статус done).
// Возвращает текст (и nextAt, если расписание продолжается) или null, если делать нечего.
export async function completeReminder(
  db: Db,
  chatId: number,
  id: string,
  nextFor: (rrule: string) => Date | null,
): Promise<{ text: string; nextAt?: Date } | null> {
  const open = ["pending", "sending", "sent"];
  const rows = check(
    await db.from("reminders").select("text,rrule")
      .eq("id", id).eq("chat_id", chatId).in("status", open).limit(1),
    "чтение напоминания",
  );
  const row = rows?.[0];
  if (!row) return null;
  const next = row.rrule ? nextFor(row.rrule as string) : null;
  if (!next) return await stopReminder(db, chatId, id);
  const updated = check(
    await db.from("reminders").update({
      status: "pending",
      remind_at: next.toISOString(),
      nag_sent: 0,
    }).eq("id", id).eq("chat_id", chatId).in("status", open).select("id"),
    "следующее срабатывание",
  );
  return (updated?.length ?? 0) > 0
    ? { text: row.text as string, nextAt: next }
    : null;
}

// Snooze: переносит сработавшее (или ожидающее) напоминание на новое время.
// Работает, пока напоминание не отменено и не закрыто «Готово»; серия повторов начинается
// заново (nag_sent = 0). Возвращает текст или null, если откладывать нечего.
export async function snoozeReminder(
  db: Db,
  chatId: number,
  id: string,
  remindAt: Date,
): Promise<{ text: string } | null> {
  const rows = check(
    await db.from("reminders").update({
      status: "pending",
      remind_at: remindAt.toISOString(),
      nag_sent: 0,
    }).eq("id", id).eq("chat_id", chatId).in("status", [
      "pending",
      "sending",
      "sent",
    ]).select("text"),
    "отложить напоминание",
  );
  return rows && rows.length > 0 ? { text: rows[0].text as string } : null;
}

// «Сдаёмся»: напоминание не удаётся доставить (бот заблокирован, чат не найден или прошло больше
// суток попыток). Без расписания → статус cancelled. С расписанием передаём nextRemindAt:
// запись возвращается в pending на следующее срабатывание, серия «каждые N минут» обнуляется.
// Обновление условное (только пока sending): решение пользователя («Готово», удаление, snooze)
// главнее. Возвращает true, если запись обновилась.
export async function abandonReminder(
  db: Db,
  id: string,
  nextRemindAt?: Date,
): Promise<boolean> {
  const rows = check(
    await db.from("reminders").update(
      nextRemindAt
        ? {
          status: "pending",
          remind_at: nextRemindAt.toISOString(),
          nag_sent: 0,
        }
        : { status: "cancelled" },
    ).eq("id", id).eq("status", "sending").select("id"),
    "отказ от отправки напоминания",
  );
  return (rows?.length ?? 0) > 0;
}

// Отправка не удалась: возвращаем в pending, следующий запуск tick попробует снова.
export async function releaseReminder(db: Db, id: string): Promise<void> {
  check(
    await db.from("reminders").update({ status: "pending" }).eq("id", id).eq(
      "status",
      "sending",
    ),
    "возврат напоминания в очередь",
  );
}
