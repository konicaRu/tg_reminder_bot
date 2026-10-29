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
  patch: { text?: string; remind_at?: Date },
): Promise<boolean> {
  const rows = check(
    await db.from("reminders").update({
      ...(patch.text !== undefined ? { text: patch.text } : {}),
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
