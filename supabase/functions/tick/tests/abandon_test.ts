// Тесты «сдаёмся»: напоминание, которое не удаётся отправить, не пытаемся слать вечно.
// Постоянные ошибки Telegram (бот заблокирован, чат не найден) → сразу сдаёмся; временные
// (сеть, 5xx) повторяем, но не дольше суток от срока. Расписание при этом не теряем.
//
// «Сейчас» для tick: 29.10.2026 08:00:30 UTC.

import { deepStrictEqual as assertEquals } from "node:assert";
import type { Reminder } from "../../_shared/db.ts";
import { runTick, type TickStore } from "../logic.ts";

const NOW = new Date("2026-10-29T08:00:30Z");

const rem = (id: string, extra: Partial<Reminder> = {}): Reminder =>
  ({
    id,
    chat_id: 555,
    text: "секретный текст",
    status: "sending",
    remind_at: "2026-10-29T08:00:00Z", // срок только что наступил
    nag_interval_min: null,
    nag_total: null,
    nag_sent: 0,
    last_message_id: null,
    rrule: null,
    ...extra,
  }) as Reminder;

function setup(
  due: Reminder[],
  o: { error: string; abandonThrows?: boolean } = { error: "Telegram: 500" },
) {
  const released: string[] = [];
  const abandoned: { id: string; next?: Date }[] = [];
  const logs: string[] = [];
  const store: TickStore = {
    claimDueReminders: () => Promise.resolve(due),
    markReminderSent: () => Promise.resolve(true),
    releaseReminder: (id) => {
      released.push(id);
      return Promise.resolve();
    },
    abandonReminder: (id, next) => {
      if (o.abandonThrows) return Promise.reject(new Error("база недоступна"));
      abandoned.push({ id, next });
      return Promise.resolve(true);
    },
    getTimezone: () => Promise.resolve("Europe/Moscow"),
  };
  const deps = {
    store,
    send: () => Promise.reject(new Error(o.error)),
    now: () => NOW,
    log: (m: string) => logs.push(m),
  };
  return { deps, released, abandoned, logs };
}

Deno.test("сдаёмся: бот заблокирован (403) → сразу отменяем, в очередь не возвращаем", async () => {
  const t = setup([rem("r1")], {
    error: "Telegram: 403 Forbidden: bot was blocked by the user",
  });
  const summary = await runTick(t.deps);
  assertEquals(summary, { claimed: 1, sent: 0, failed: 1 });
  assertEquals(t.abandoned, [{ id: "r1", next: undefined }]);
  assertEquals(t.released, []);
});

Deno.test("сдаёмся: чат не найден (400 chat not found) → сразу отменяем", async () => {
  const t = setup([rem("r1")], {
    error: "Telegram: 400 Bad Request: chat not found",
  });
  await runTick(t.deps);
  assertEquals(t.abandoned.length, 1);
  assertEquals(t.released, []);
});

Deno.test("временная ошибка (сеть/5xx) и срок недавний → возвращаем в очередь, как раньше", async () => {
  const t = setup([rem("r1")], { error: "Telegram: 500 oops" });
  await runTick(t.deps);
  assertEquals(t.released, ["r1"]);
  assertEquals(t.abandoned, []);
});

Deno.test("временная ошибка, но с момента срока прошло больше суток → сдаёмся", async () => {
  const t = setup([rem("r1", { remind_at: "2026-10-27T08:00:00Z" })], {
    error: "Telegram: сеть недоступна или превышено время ожидания",
  });
  await runTick(t.deps);
  assertEquals(t.abandoned.length, 1);
  assertEquals(t.released, []);
});

Deno.test("граница суток: чуть меньше суток → ещё пробуем, чуть больше → сдаёмся", async () => {
  const under = setup([rem("a", { remind_at: "2026-10-28T08:01:00Z" })], {
    error: "Telegram: 500",
  });
  await runTick(under.deps);
  assertEquals(under.released, ["a"]);
  const over = setup([rem("b", { remind_at: "2026-10-28T08:00:00Z" })], {
    error: "Telegram: 500",
  });
  await runTick(over.deps);
  assertEquals(over.abandoned.length, 1);
});

Deno.test("расписание: при отказе переносим на следующее срабатывание, расписание не теряем", async () => {
  const t = setup(
    [rem("r1", { rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0" })],
    { error: "Telegram: 403 Forbidden: bot was blocked by the user" },
  );
  await runTick(t.deps);
  // сейчас 11:00 по Москве → следующее 30.10 в 09:00 (06:00 UTC)
  assertEquals(t.abandoned, [{
    id: "r1",
    next: new Date("2026-10-30T06:00:00Z"),
  }]);
});

Deno.test("серия «каждые N минут»: при отказе серию прекращаем (обычное напоминание → отмена)", async () => {
  const t = setup(
    [rem("r1", { nag_interval_min: 5, nag_total: 10, nag_sent: 3 })],
    { error: "Telegram: 403 Forbidden: bot was blocked by the user" },
  );
  await runTick(t.deps);
  assertEquals(t.abandoned, [{ id: "r1", next: undefined }]);
});

Deno.test("отказ: в лог id и причина, но не текст напоминания", async () => {
  const t = setup([rem("r1")], {
    error: "Telegram: 403 Forbidden: bot was blocked by the user",
  });
  await runTick(t.deps);
  assertEquals(t.logs.some((l) => l.includes("r1")), true);
  assertEquals(t.logs.some((l) => l.includes("секретный текст")), false);
});

Deno.test("отказ: сбой базы при «сдаваться» не роняет tick (запись вернётся из sending сама через 5 минут)", async () => {
  const t = setup([rem("r1"), rem("r2")], {
    error: "Telegram: 403 Forbidden: bot was blocked by the user",
    abandonThrows: true,
  });
  const summary = await runTick(t.deps);
  assertEquals(summary, { claimed: 2, sent: 0, failed: 2 }); // второе тоже обработано
  assertEquals(t.logs.some((l) => l.includes("r2")), true);
});
