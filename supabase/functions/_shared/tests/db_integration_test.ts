// Интеграционные тесты слоя БД: работают с НАСТОЯЩЕЙ базой Supabase.
// «Интеграционные» = проверяют не отдельную функцию, а связку «наш код + реальная база».
//
// Запускаются только если заданы переменные окружения SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY,
// иначе тесты пропускаются (ignore), и обычный `deno test` остаётся быстрым и без сети.
// Нужна уже применённая миграция (шаг 8 плана). Тесты работают с «тестовым» чатом
// с отрицательным id, которого у настоящих пользователей не бывает, и за собой убирают.
//
// Запуск (ключ берём из Supabase, в git его не кладём):
//   $env:SUPABASE_URL="https://<ref>.supabase.co"; $env:SUPABASE_SERVICE_ROLE_KEY="..."
//   deno test --allow-env --allow-net supabase/functions/_shared/tests/db_integration_test.ts

import { deepStrictEqual as assertEquals } from "node:assert";
import {
  cancelReminder,
  claimDueReminders,
  clearSession,
  createDb,
  createReminder,
  DEFAULT_SETTINGS,
  getSession,
  getSettings,
  listPendingReminders,
  markReminderSent,
  releaseReminder,
  setSession,
} from "../db.ts";

// Без флага --allow-env читать переменные нельзя (Deno защищает от этого по умолчанию),
// поэтому сначала спрашиваем, есть ли разрешение, и только потом читаем.
const canReadEnv =
  Deno.permissions.querySync({ name: "env" }).state === "granted";
const ENABLED = canReadEnv &&
  !!(Deno.env.get("SUPABASE_URL") && Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const CHAT = -999000111; // тестовый чат
const FUTURE = () => new Date(Date.now() + 60 * 60 * 1000);
const PAST = () => new Date(Date.now() - 60 * 1000);

// Обёртка: пропускает тест без ключей и чистит тестовые данные до и после.
function dbTest(
  name: string,
  fn: (db: ReturnType<typeof createDb>) => Promise<void>,
) {
  Deno.test({
    name: `БД: ${name}`,
    ignore: !ENABLED,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      const db = createDb();
      const cleanup = async () => {
        await db.from("reminders").delete().eq("chat_id", CHAT);
        await db.from("sessions").delete().eq("chat_id", CHAT);
        await db.from("settings").delete().eq("chat_id", CHAT);
      };
      await cleanup();
      try {
        await fn(db);
      } finally {
        await cleanup();
      }
    },
  });
}

dbTest(
  "создали напоминание → оно в списке, статус pending, время сохранилось",
  async (db) => {
    const when = FUTURE();
    const r = await createReminder(db, {
      chat_id: CHAT,
      text: "проверка",
      remind_at: when,
    });
    assertEquals(r.status, "pending");
    assertEquals(r.rrule, null);
    const list = await listPendingReminders(db, CHAT);
    assertEquals(list.length, 1);
    assertEquals(list[0].id, r.id);
    assertEquals(new Date(list[0].remind_at).getTime(), when.getTime());
  },
);

dbTest("список отсортирован по времени, чужие чаты не видны", async (db) => {
  const later = new Date(Date.now() + 2 * 3600 * 1000);
  await createReminder(db, { chat_id: CHAT, text: "позже", remind_at: later });
  await createReminder(db, {
    chat_id: CHAT,
    text: "раньше",
    remind_at: FUTURE(),
  });
  assertEquals((await listPendingReminders(db, CHAT)).map((r) => r.text), [
    "раньше",
    "позже",
  ]);
  assertEquals((await listPendingReminders(db, CHAT - 1)).length, 0);
});

dbTest("отмена: свою можно, чужую нельзя, повторная — false", async (db) => {
  const r = await createReminder(db, {
    chat_id: CHAT,
    text: "удалить",
    remind_at: FUTURE(),
  });
  assertEquals(await cancelReminder(db, CHAT - 1, r.id), false); // чужой чат
  assertEquals(await cancelReminder(db, CHAT, r.id), true);
  assertEquals(await cancelReminder(db, CHAT, r.id), false); // уже отменено
  assertEquals((await listPendingReminders(db, CHAT)).length, 0);
});

dbTest("claim: берёт только наступившие, будущие не трогает", async (db) => {
  await createReminder(db, {
    chat_id: CHAT,
    text: "наступило",
    remind_at: PAST(),
  });
  await createReminder(db, {
    chat_id: CHAT,
    text: "будущее",
    remind_at: FUTURE(),
  });
  const got = (await claimDueReminders(db)).filter((r) => r.chat_id === CHAT);
  assertEquals(got.map((r) => r.text), ["наступило"]);
  assertEquals(got[0].status, "sending");
});

dbTest(
  "claim: идемпотентность — два одновременных вызова, напоминание достаётся одному",
  async (db) => {
    await createReminder(db, {
      chat_id: CHAT,
      text: "один раз",
      remind_at: PAST(),
    });
    const [a, b] = await Promise.all([
      claimDueReminders(db),
      claimDueReminders(db),
    ]);
    const total = [...a, ...b].filter((r) => r.chat_id === CHAT).length;
    assertEquals(total, 1);
  },
);

dbTest(
  "claim: просроченное досылается (давно прошедшее время тоже берётся)",
  async (db) => {
    const longAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    await createReminder(db, {
      chat_id: CHAT,
      text: "пропущено",
      remind_at: longAgo,
    });
    const got = (await claimDueReminders(db)).filter((r) => r.chat_id === CHAT);
    assertEquals(got.length, 1);
  },
);

dbTest(
  "sent: после отправки статус sent и запомнен id сообщения; повторно не берётся",
  async (db) => {
    const r = await createReminder(db, {
      chat_id: CHAT,
      text: "отправим",
      remind_at: PAST(),
    });
    await claimDueReminders(db);
    await markReminderSent(db, r.id, 12345);
    const { data } = await db.from("reminders").select(
      "status, last_message_id",
    ).eq("id", r.id)
      .single();
    assertEquals(data, { status: "sent", last_message_id: 12345 });
    assertEquals(
      (await claimDueReminders(db)).filter((x) => x.chat_id === CHAT).length,
      0,
    );
  },
);

dbTest(
  "release: неудачная отправка возвращает напоминание в очередь",
  async (db) => {
    const r = await createReminder(db, {
      chat_id: CHAT,
      text: "не вышло",
      remind_at: PAST(),
    });
    await claimDueReminders(db);
    await releaseReminder(db, r.id);
    const again = (await claimDueReminders(db)).filter((x) =>
      x.chat_id === CHAT
    );
    assertEquals(again.length, 1);
  },
);

dbTest(
  "настройки: нет строки → значения по умолчанию; есть → берём из базы",
  async (db) => {
    assertEquals(await getSettings(db, CHAT), DEFAULT_SETTINGS);
    await db.from("settings").insert({
      chat_id: CHAT,
      timezone: "Asia/Yekaterinburg",
      default_time: "08:30",
    });
    assertEquals(await getSettings(db, CHAT), {
      timezone: "Asia/Yekaterinburg",
      default_time: "08:30",
    });
  },
);

dbTest("сессии: записать, прочитать, заменить, очистить", async (db) => {
  assertEquals(await getSession(db, CHAT), null);
  await setSession(db, CHAT, "confirm", { id: "a1b2c3d4", text: "встреча" });
  assertEquals(await getSession(db, CHAT), {
    state: "confirm",
    payload: { id: "a1b2c3d4", text: "встреча" },
  });
  await setSession(db, CHAT, "awaiting_time", { draft: "x" });
  assertEquals((await getSession(db, CHAT))?.state, "awaiting_time");
  await clearSession(db, CHAT);
  assertEquals(await getSession(db, CHAT), null);
});
