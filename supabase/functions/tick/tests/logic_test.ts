// Тесты функции tick: «будильник», который раз в минуту отправляет наступившие напоминания.
// База и Telegram — «двойники» в памяти, настоящая сеть не нужна.

import { deepStrictEqual as assertEquals } from "node:assert";
import type { Reminder } from "../../_shared/db.ts";
import {
  handleRequest,
  isAuthorized,
  runTick,
  type TickStore,
} from "../logic.ts";

const SECRET = "tick-secret-123";

// Обычное напоминание (без серии повторов).
const rem = (id: string, chat: number, text: string): Reminder =>
  ({
    id,
    chat_id: chat,
    text,
    status: "sending",
    remind_at: "2026-10-29T08:00:00Z",
    nag_interval_min: null,
    nag_total: null,
    nag_sent: 0,
    last_message_id: null,
  }) as Reminder;

// Напоминание с серией: каждые intervalMin минут, всего total; sent уже отправлено;
// lastMsg — id предыдущего сообщения серии (у кого sent = 0, его нет).
const nagRem = (
  id: string,
  o: { interval: number; total: number; sent: number; lastMsg?: number },
): Reminder => ({
  ...rem(id, 555, "лекарство"),
  nag_interval_min: o.interval,
  nag_total: o.total,
  nag_sent: o.sent,
  last_message_id: o.lastMsg ?? null,
});

// «Сейчас» для tick в тестах: новое время повтора считается от него.
const NOW = new Date("2026-10-29T08:00:30Z");

// Двойник: что «лежит в очереди» и что с ней сделали.
function setup(
  due: Reminder[],
  opts: {
    failSendFor?: string[];
    claimThrows?: boolean;
    userStoppedFirst?: boolean; // пользователь нажал «Готово», пока шла отправка
    clearThrows?: boolean;
  } = {},
) {
  const sentMessages: { chatId: number; text: string; markup?: unknown }[] = [];
  const marked: {
    id: string;
    messageId: number;
    next: { nagSent?: number; nextRemindAt?: Date };
  }[] = [];
  const released: string[] = [];
  const cleared: { chatId: number; messageId: number; afterSends: number }[] =
    [];
  const logs: string[] = [];
  let claimCalls = 0;
  let messageCounter = 100;

  const store: TickStore = {
    claimDueReminders: () => {
      claimCalls++;
      if (opts.claimThrows) return Promise.reject(new Error("база недоступна"));
      return Promise.resolve(due);
    },
    markReminderSent: (id, messageId, next) => {
      marked.push({ id, messageId, next });
      // false = запись уже не в статусе sending (пользователь успел нажать «Готово»)
      return Promise.resolve(!opts.userStoppedFirst);
    },
    releaseReminder: (id) => {
      released.push(id);
      return Promise.resolve();
    },
    getTimezone: () => Promise.resolve("Europe/Moscow"),
  };

  const send = (chatId: number, text: string, markup?: unknown) => {
    if (opts.failSendFor?.some((t) => text.includes(t))) {
      return Promise.reject(new Error("Telegram: 500"));
    }
    // поле markup записываем только если кнопки были: так проще сравнивать с ожидаемым
    sentMessages.push(
      markup === undefined ? { chatId, text } : { chatId, text, markup },
    );
    return Promise.resolve(++messageCounter);
  };

  // «Снять кнопки у старого сообщения»; запоминаем, после скольких отправок это произошло.
  const clearKeyboard = (chatId: number, messageId: number) => {
    cleared.push({ chatId, messageId, afterSends: sentMessages.length });
    return opts.clearThrows
      ? Promise.reject(new Error("Telegram: 400 message to edit not found"))
      : Promise.resolve();
  };

  const deps = {
    store,
    send,
    clearKeyboard,
    now: () => NOW,
    log: (m: string) => logs.push(m),
  };
  return {
    deps,
    sentMessages,
    marked,
    released,
    cleared,
    logs,
    claimCalls: () => claimCalls,
  };
}

// --- Основной цикл -----------------------------------------------------------

Deno.test("tick: нечего отправлять → ничего не шлёт", async () => {
  const t = setup([]);
  const summary = await runTick(t.deps);
  assertEquals(summary, { claimed: 0, sent: 0, failed: 0 });
  assertEquals(t.sentMessages.length, 0);
});

Deno.test("tick: отправляет текст напоминания в нужный чат и отмечает «отправлено»", async () => {
  const t = setup([rem("r1", 555, "встреча")]);
  const summary = await runTick(t.deps);
  assertEquals(t.sentMessages, [{
    chatId: 555,
    text: "⏰ <b>Напоминание</b>\nвстреча",
    markup: doneButton("r1"), // и у обычного напоминания есть snooze и «Готово»
  }]);
  // запомнили id сообщения; у обычного напоминания повторов нет → next пустой
  assertEquals(t.marked, [{ id: "r1", messageId: 101, next: {} }]);
  assertEquals(summary, { claimed: 1, sent: 1, failed: 0 });
});

Deno.test("tick: текст пользователя экранируется (иначе Telegram отклонит сообщение)", async () => {
  const t = setup([rem("r1", 555, "a < b & c")]);
  await runTick(t.deps);
  assertEquals(
    t.sentMessages[0].text,
    "⏰ <b>Напоминание</b>\na &lt; b &amp; c",
  );
});

Deno.test("tick: несколько напоминаний уходят по порядку", async () => {
  const t = setup([
    rem("r1", 1, "первое"),
    rem("r2", 1, "второе"),
    rem("r3", 1, "третье"),
  ]);
  const summary = await runTick(t.deps);
  assertEquals(t.marked.map((m) => m.id), ["r1", "r2", "r3"]);
  assertEquals(summary, { claimed: 3, sent: 3, failed: 0 });
});

Deno.test("tick: если одно не отправилось — возвращаем в очередь, остальные всё равно уходят", async () => {
  const t = setup(
    [
      rem("r1", 1, "хорошее"),
      rem("r2", 1, "ПЛОХОЕ"),
      rem("r3", 1, "тоже хорошее"),
    ],
    { failSendFor: ["ПЛОХОЕ"] },
  );
  const summary = await runTick(t.deps);
  assertEquals(t.released, ["r2"]); // вернули в pending, следующий запуск попробует снова
  assertEquals(t.marked.map((m) => m.id), ["r1", "r3"]);
  assertEquals(summary, { claimed: 3, sent: 2, failed: 1 });
});

Deno.test("tick: ошибка пишется в лог без текста напоминания (там может быть личное)", async () => {
  const t = setup([rem("r2", 1, "секретное ПЛОХОЕ")], {
    failSendFor: ["ПЛОХОЕ"],
  });
  await runTick(t.deps);
  assertEquals(t.logs.length, 1);
  assertEquals(t.logs[0].includes("r2"), true);
  assertEquals(t.logs[0].includes("секретное"), false);
});

Deno.test("tick: если базу забрать не удалось — ошибка наружу (запуск будет повторен через минуту)", async () => {
  const t = setup([], { claimThrows: true });
  let threw = false;
  try {
    await runTick(t.deps);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// --- Проверка секрета --------------------------------------------------------

Deno.test("секрет: верный — пускаем", () => {
  assertEquals(isAuthorized(SECRET, SECRET), true);
});

Deno.test("секрет: неверный, пустой, отсутствующий, другой длины — не пускаем", () => {
  assertEquals(isAuthorized("wrong", SECRET), false);
  assertEquals(isAuthorized("", SECRET), false);
  assertEquals(isAuthorized(null, SECRET), false);
  assertEquals(isAuthorized(SECRET + "x", SECRET), false);
  assertEquals(isAuthorized(SECRET.slice(0, -1), SECRET), false);
});

Deno.test("секрет: если секрет на сервере пустой — не пускаем никого (а не всех)", () => {
  assertEquals(isAuthorized("", ""), false);
  assertEquals(isAuthorized(null, ""), false);
});

// --- HTTP-обёртка ------------------------------------------------------------

const post = (headers: Record<string, string> = {}) =>
  new Request("http://x/", { method: "POST", headers });

Deno.test("HTTP: без секрета → 401, и в базу даже не заглядываем", async () => {
  const t = setup([rem("r1", 1, "встреча")]);
  const res = await handleRequest(post(), {
    secret: SECRET,
    run: () => runTick(t.deps),
  });
  assertEquals(res.status, 401);
  assertEquals(t.claimCalls(), 0);
  assertEquals(t.sentMessages.length, 0);
});

Deno.test("HTTP: неверный секрет → 401", async () => {
  const t = setup([rem("r1", 1, "встреча")]);
  const res = await handleRequest(post({ "x-tick-secret": "nope" }), {
    secret: SECRET,
    run: () => runTick(t.deps),
  });
  assertEquals(res.status, 401);
  assertEquals(t.claimCalls(), 0);
});

Deno.test("HTTP: GET вместо POST → 405", async () => {
  const t = setup([]);
  const res = await handleRequest(
    new Request("http://x/", {
      method: "GET",
      headers: { "x-tick-secret": SECRET },
    }),
    { secret: SECRET, run: () => runTick(t.deps) },
  );
  assertEquals(res.status, 405);
});

Deno.test("HTTP: верный секрет → 200 и сводка", async () => {
  const t = setup([rem("r1", 1, "встреча")]);
  const res = await handleRequest(post({ "x-tick-secret": SECRET }), {
    secret: SECRET,
    run: () => runTick(t.deps),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { claimed: 1, sent: 1, failed: 0 });
});

Deno.test("HTTP: сбой внутри → 500 без подробностей наружу", async () => {
  const t = setup([], { claimThrows: true });
  const res = await handleRequest(post({ "x-tick-secret": SECRET }), {
    secret: SECRET,
    run: () => runTick(t.deps),
  });
  assertEquals(res.status, 500);
  const text = await res.text();
  assertEquals(text.includes("база недоступна"), false);
});

// =============================================================================
// «Настойчивое» напоминание: серия повторов до «Готово»
// =============================================================================

// кнопки под любым сработавшим напоминанием: snooze и «Готово»
const doneButton = (id: string) => ({
  inline_keyboard: [
    [
      { text: "+10 мин", callback_data: `snz:${id}:10` },
      { text: "+1 час", callback_data: `snz:${id}:60` },
      { text: "Завтра", callback_data: `snz:${id}:1440` },
    ],
    [{ text: "✅ Готово", callback_data: `done:${id}` }],
  ],
});

Deno.test("серия: первое сообщение «(1 из 3)» с кнопкой «Готово»; запись возвращается в очередь на now + интервал", async () => {
  const t = setup([nagRem("n1", { interval: 5, total: 3, sent: 0 })]);
  const summary = await runTick(t.deps);
  assertEquals(t.sentMessages, [{
    chatId: 555,
    text: "⏰ <b>Напоминание</b> (1 из 3)\nлекарство",
    markup: doneButton("n1"),
  }]);
  assertEquals(t.marked, [{
    id: "n1",
    messageId: 101,
    // от момента отправки (NOW), а не от старого срока (после сбоя не будет «пачки» повторов), и округлено
    // вниз до начала минуты: tick срабатывает ровно в :00, иначе 5 минут превратились бы в 6
    next: { nagSent: 1, nextRemindAt: new Date("2026-10-29T08:05:00Z") },
  }]);
  assertEquals(summary, { claimed: 1, sent: 1, failed: 0 });
});

Deno.test("серия: у первого сообщения нет предыдущего, снимать кнопки не у кого", async () => {
  const t = setup([nagRem("n1", { interval: 5, total: 3, sent: 0 })]);
  await runTick(t.deps);
  assertEquals(t.cleared, []);
});

Deno.test("серия: второе сообщение «(2 из 3)»; у предыдущего сообщения кнопка снимается ПОСЛЕ успешной отправки", async () => {
  const t = setup([
    nagRem("n1", { interval: 10, total: 3, sent: 1, lastMsg: 77 }),
  ]);
  await runTick(t.deps);
  assertEquals(
    t.sentMessages[0].text,
    "⏰ <b>Напоминание</b> (2 из 3)\nлекарство",
  );
  assertEquals(t.marked[0].next, {
    nagSent: 2,
    nextRemindAt: new Date("2026-10-29T08:10:00Z"),
  });
  // кнопку у старого сообщения (id 77) убрали, и только когда новое уже ушло (afterSends = 1)
  assertEquals(t.cleared, [{ chatId: 555, messageId: 77, afterSends: 1 }]);
});

Deno.test("серия: последнее сообщение «(3 из 3)» → повтор больше не планируется, статус sent", async () => {
  const t = setup([
    nagRem("n1", { interval: 5, total: 3, sent: 2, lastMsg: 88 }),
  ]);
  await runTick(t.deps);
  assertEquals(
    t.sentMessages[0].text,
    "⏰ <b>Напоминание</b> (3 из 3)\nлекарство",
  );
  // кнопка «Готово» остаётся и на последнем сообщении (нажатие просто отмечает «Готово»)
  assertEquals(t.sentMessages[0].markup, doneButton("n1"));
  // nextRemindAt нет → db.markReminderSent поставит статус sent
  assertEquals(t.marked[0].next, { nagSent: 3 });
});

Deno.test("серия: не удалось отправить → в очередь, счётчик не растёт, кнопку у старого сообщения НЕ снимаем", async () => {
  const t = setup(
    [nagRem("n1", { interval: 5, total: 3, sent: 1, lastMsg: 77 })],
    { failSendFor: ["лекарство"] },
  );
  const summary = await runTick(t.deps);
  assertEquals(t.released, ["n1"]);
  assertEquals(t.marked, []);
  assertEquals(t.cleared, []); // у пользователя остаётся рабочая кнопка «Готово»
  assertEquals(summary, { claimed: 1, sent: 0, failed: 1 });
});

Deno.test("серия: «Готово» нажали, пока шла отправка → не ошибка и не в очередь (решение пользователя главнее)", async () => {
  const t = setup(
    [nagRem("n1", { interval: 5, total: 3, sent: 0 })],
    { userStoppedFirst: true },
  );
  const summary = await runTick(t.deps);
  assertEquals(t.released, []); // не возвращаем в pending
  assertEquals(summary, { claimed: 1, sent: 1, failed: 0 }); // сообщение ведь ушло
  assertEquals(t.logs, []); // это штатная ситуация, шума в логах нет
});

Deno.test("серия: сбой снятия кнопки у старого сообщения не мешает, пишется в лог без текста напоминания", async () => {
  const t = setup(
    [nagRem("n1", { interval: 5, total: 3, sent: 1, lastMsg: 77 })],
    { clearThrows: true },
  );
  const summary = await runTick(t.deps);
  assertEquals(summary, { claimed: 1, sent: 1, failed: 0 });
  assertEquals(t.marked.length, 1); // следующий повтор запланирован, несмотря на сбой
  assertEquals(t.logs.length, 1);
  assertEquals(t.logs[0].includes("n1"), true);
  assertEquals(t.logs[0].includes("лекарство"), false);
});

Deno.test("серия вперемешку с обычными: каждое обрабатывается по своим правилам", async () => {
  const t = setup([
    rem("r1", 1, "обычное"),
    nagRem("n1", { interval: 5, total: 3, sent: 0 }),
  ]);
  await runTick(t.deps);
  assertEquals(t.sentMessages[0], {
    chatId: 1,
    text: "⏰ <b>Напоминание</b>\nобычное",
    markup: doneButton("r1"),
  });
  assertEquals(t.marked[0].next, {}); // обычное → sent
  assertEquals(t.marked[1].next.nagSent, 1); // серия → ещё повторы
});

// =============================================================================
// Повторы по расписанию
// =============================================================================

// Напоминание «каждый день в 9»; NOW = 29.10 11:00:30 по Москве, так что следующее — 30.10 09:00.
const DAILY9 = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
const schedRem = (id: string, extra: Partial<Reminder> = {}): Reminder => ({
  ...rem(id, 555, "зарядка"),
  rrule: DAILY9,
  ...extra,
});
// кнопки у сработавшего напоминания по расписанию: snooze, «Готово» и «Прекратить повторы»
const schedButtons = (id: string) => ({
  inline_keyboard: [
    [
      { text: "+10 мин", callback_data: `snz:${id}:10` },
      { text: "+1 час", callback_data: `snz:${id}:60` },
      { text: "Завтра", callback_data: `snz:${id}:1440` },
    ],
    [
      { text: "✅ Готово", callback_data: `done:${id}` },
      { text: "⛔ Прекратить повторы", callback_data: `stop:${id}` },
    ],
  ],
});

Deno.test("расписание: после отправки запись не закрывается, а планируется на следующее срабатывание", async () => {
  const t = setup([schedRem("s1")]);
  const summary = await runTick(t.deps);
  assertEquals(t.sentMessages[0].markup, schedButtons("s1"));
  assertEquals(t.marked, [{
    id: "s1",
    messageId: 101,
    next: { nextRemindAt: new Date("2026-10-30T06:00:00Z") }, // завтра 09:00 МСК
  }]);
  assertEquals(summary, { claimed: 1, sent: 1, failed: 0 });
});

Deno.test("расписание: следующее считается от «сейчас», а не от старого срока (после простоя нет пачки)", async () => {
  // срок был 3 дня назад, tick простоял
  const t = setup([schedRem("s1", { remind_at: "2026-10-26T06:00:00Z" })]);
  await runTick(t.deps);
  assertEquals(t.marked.length, 1);
  assertEquals(
    t.marked[0].next.nextRemindAt,
    new Date("2026-10-30T06:00:00Z"),
  );
  assertEquals(t.sentMessages.length, 1); // одно сообщение, а не три
});

Deno.test("расписание: у предыдущего срабатывания снимаем кнопки", async () => {
  const t = setup([schedRem("s1", { last_message_id: 77 })]);
  await runTick(t.deps);
  assertEquals(t.cleared, [{ chatId: 555, messageId: 77, afterSends: 1 }]);
});

Deno.test("расписание + серия: пока серия идёт — интервал, после последнего сообщения — следующее по расписанию", async () => {
  const mid = setup([
    schedRem("s1", { nag_interval_min: 5, nag_total: 3, nag_sent: 0 }),
  ]);
  await runTick(mid.deps);
  assertEquals(mid.marked[0].next, {
    nagSent: 1,
    nextRemindAt: new Date("2026-10-29T08:05:00Z"),
  });
  const last = setup([
    schedRem("s2", { nag_interval_min: 5, nag_total: 3, nag_sent: 2 }),
  ]);
  await runTick(last.deps);
  assertEquals(last.marked[0].next, {
    nagSent: 0, // серия закончилась: к следующему срабатыванию счётчик с нуля
    nextRemindAt: new Date("2026-10-30T06:00:00Z"),
  });
});

Deno.test("расписание: «Прекратить повторы» во время отправки главнее (ответ false — не возобновляем)", async () => {
  const t = setup([schedRem("s1")], { userStoppedFirst: true });
  const summary = await runTick(t.deps);
  assertEquals(summary, { claimed: 1, sent: 1, failed: 0 });
  assertEquals(t.marked.length, 1); // попытка была, база ответила «уже не sending»
});

Deno.test("расписание: битая строка rrule → напоминание считается обычным (sent), в лог пишем без текста", async () => {
  const t = setup([schedRem("s1", { rrule: "FREQ=MONTHLY" })]);
  await runTick(t.deps);
  assertEquals(t.marked[0].next, {});
  assertEquals(t.logs.some((l) => l.includes("s1")), true);
  assertEquals(t.logs.some((l) => l.includes("зарядка")), false);
});

Deno.test("расписание: часовой пояс берём из настроек чата (Екатеринбург, 09:00 = 04:00Z)", async () => {
  const t = setup([schedRem("s1")]);
  const deps = {
    ...t.deps,
    store: {
      ...t.deps.store,
      getTimezone: () => Promise.resolve("Asia/Yekaterinburg"),
    },
  };
  await runTick(deps);
  // NOW = 08:00:30Z = 13:00 по Екатеринбургу → следующее 30.10 09:00 по Екатеринбургу
  assertEquals(
    t.marked[0].next.nextRemindAt,
    new Date("2026-10-30T04:00:00Z"),
  );
});
