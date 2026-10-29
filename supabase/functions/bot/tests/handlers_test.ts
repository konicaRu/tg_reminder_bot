// Тесты «мозга» бота: что он отвечает и что пишет в базу на каждое действие пользователя.
// Настоящих Telegram и базы здесь нет: вместо них «двойники» (fake) в памяти.
// Парсер дат используем настоящий, чтобы проверять реальную связку.

import { deepStrictEqual as assertEquals } from "node:assert";
import { parseReminder } from "../../_shared/parser/mod.ts";
import type { ParseResult } from "../../_shared/parser/mod.ts";
import type { Reminder, Session, Settings } from "../../_shared/db.ts";
import {
  createHandlers,
  type Io,
  isAllowed,
  parseAllowedIds,
  type Store,
} from "../handlers.ts";

const NOW = new Date("2026-10-28T09:00:00Z"); // среда, 12:00 по Москве
const CHAT = 234320036;

type Sent = {
  kind: "reply" | "edit" | "answer";
  text?: string;
  markup?: unknown;
};

// «Двойник» окружения: хранилище в памяти + журнал того, что бот отправил в Telegram.
function setup(opts: { llm?: (input: string) => Promise<ParseResult> } = {}) {
  const sessions = new Map<number, Session>();
  const reminders: Reminder[] = [];
  const sent: Sent[] = [];
  let llmCalls = 0;
  let idCounter = 0;

  const store: Store = {
    getSettings: () =>
      Promise.resolve(
        { timezone: "Europe/Moscow", default_time: "09:00" } as Settings,
      ),
    getSession: (chatId) => Promise.resolve(sessions.get(chatId) ?? null),
    setSession: (chatId, state, payload) => {
      sessions.set(chatId, { state, payload });
      return Promise.resolve();
    },
    clearSession: (chatId) => {
      sessions.delete(chatId);
      return Promise.resolve();
    },
    createReminder: (r) => {
      const row = {
        id: `rem-${reminders.length + 1}`,
        chat_id: r.chat_id,
        text: r.text,
        remind_at: r.remind_at.toISOString(),
        rrule: r.rrule,
        status: "pending",
        nag_interval_min: r.nag?.intervalMin ?? null,
        nag_total: r.nag?.total ?? null,
        nag_sent: 0,
      } as Reminder;
      reminders.push(row);
      return Promise.resolve(row);
    },
    // «Готово»: останавливает напоминание, пока оно не отменено (как в db.ts)
    stopReminder: (chatId, id) => {
      const r = reminders.find((x) =>
        x.id === id && x.chat_id === chatId &&
        ["pending", "sending", "sent"].includes(x.status)
      );
      if (!r) return Promise.resolve(null);
      r.status = "done";
      return Promise.resolve({ text: r.text });
    },
    // «Готово»: у напоминания по расписанию — к следующему срабатыванию, у обычного — закрыть
    completeReminder: (chatId, id, nextFor) => {
      const r = reminders.find((x) =>
        x.id === id && x.chat_id === chatId &&
        ["pending", "sending", "sent"].includes(x.status)
      );
      if (!r) return Promise.resolve(null);
      const next = r.rrule ? nextFor(r.rrule) : null;
      if (next) {
        r.status = "pending";
        r.remind_at = next.toISOString();
        r.nag_sent = 0;
        return Promise.resolve({ text: r.text, nextAt: next });
      }
      r.status = "done";
      return Promise.resolve({ text: r.text });
    },
    // snooze: пока запись не отменена/закрыта; серию начинаем заново (как в db.ts)
    snoozeReminder: (chatId, id, remindAt) => {
      const r = reminders.find((x) =>
        x.id === id && x.chat_id === chatId &&
        ["pending", "sending", "sent"].includes(x.status)
      );
      if (!r) return Promise.resolve(null);
      r.status = "pending";
      r.remind_at = remindAt.toISOString();
      r.nag_sent = 0;
      return Promise.resolve({ text: r.text });
    },
    getReminder: (chatId, id) =>
      Promise.resolve(
        reminders.find((x) =>
          x.id === id && x.chat_id === chatId && x.status === "pending"
        ) ?? null,
      ),
    // правка: только пока напоминание pending (как в db.ts); смена времени обнуляет серию
    updateReminder: (chatId, id, patch) => {
      const r = reminders.find((x) =>
        x.id === id && x.chat_id === chatId && x.status === "pending"
      );
      if (!r) return Promise.resolve(false);
      if (patch.text !== undefined) r.text = patch.text;
      if (patch.rrule !== undefined) r.rrule = patch.rrule;
      if (patch.remind_at) {
        r.remind_at = patch.remind_at.toISOString();
        r.nag_sent = 0;
      }
      return Promise.resolve(true);
    },
    listPendingReminders: (chatId) =>
      Promise.resolve(
        reminders.filter((r) => r.chat_id === chatId && r.status === "pending"),
      ),
    cancelReminder: (chatId, id) => {
      const r = reminders.find((x) =>
        x.id === id && x.chat_id === chatId && x.status === "pending"
      );
      if (!r) return Promise.resolve(false);
      r.status = "cancelled";
      return Promise.resolve(true);
    },
  };

  const io: Io = {
    chatId: CHAT,
    reply: (text, markup) => {
      sent.push({ kind: "reply", text, markup });
      return Promise.resolve();
    },
    edit: (text, markup) => {
      sent.push({ kind: "edit", text, markup });
      return Promise.resolve();
    },
    answer: (text) => {
      sent.push({ kind: "answer", text });
      return Promise.resolve();
    },
  };

  const h = createHandlers({
    store,
    parse: (input, o) => parseReminder(input, o),
    llm: opts.llm
      ? (input) => {
        llmCalls++;
        return opts.llm!(input);
      }
      : undefined,
    now: () => NOW,
    newId: () => `draft${++idCounter}`,
  });

  return { h, io, sessions, reminders, sent, llmCalls: () => llmCalls };
}

const llmFails = () =>
  Promise.resolve({ ok: false, reason: "llm_unavailable" } as ParseResult);

// Достаёт из последнего ответа бота callback_data кнопки по её подписи.
function buttonData(sent: Sent[], label: string): string {
  for (const s of [...sent].reverse()) {
    const kb = (s.markup as {
      inline_keyboard?: { text: string; callback_data: string }[][];
    })
      ?.inline_keyboard;
    const btn = kb?.flat().find((b) => b.text.includes(label));
    if (btn) return btn.callback_data;
  }
  throw new Error(`кнопка «${label}» не найдена`);
}

// --- Whitelist ---------------------------------------------------------------

Deno.test("whitelist: пускаем только тех, кто в списке", () => {
  assertEquals(isAllowed(CHAT, [CHAT]), true);
  assertEquals(isAllowed(111, [CHAT]), false);
  assertEquals(isAllowed(undefined, [CHAT]), false);
  // несколько человек (семья)
  assertEquals(isAllowed(111, [CHAT, 111]), true);
  assertEquals(isAllowed(222, [CHAT, 111]), false);
  assertEquals(isAllowed(CHAT, []), false); // пустой список не пускает никого
});

Deno.test("ALLOWED_USER_ID: один или несколько id через запятую", () => {
  assertEquals(parseAllowedIds("234320036"), [234320036]);
  assertEquals(parseAllowedIds("234320036,111222333"), [234320036, 111222333]);
  assertEquals(parseAllowedIds(" 1 , 2 ,1"), [1, 2]); // пробелы и дубли
});

Deno.test("ALLOWED_USER_ID: мусор и пустое — ошибка (бот не стартует открытым)", () => {
  for (
    const bad of [
      undefined,
      "",
      "  ",
      "abc",
      "0",
      "-5",
      "1.5",
      "1,,2",
      "1,abc",
      "1,",
      ",1",
    ]
  ) {
    let threw = false;
    try {
      parseAllowedIds(bad);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `должна быть ошибка для ${JSON.stringify(bad)}`);
  }
});

Deno.test("несколько человек: чужой не видит, не удаляет и не правит напоминания другого", async () => {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  const other: Io = { ...t.io, chatId: CHAT + 1 };
  await t.h.list(other);
  assertEquals(t.sent.at(-1)!.text, "Напоминаний пока нет.");
  await t.h.callback(other, "del:rem-1");
  await t.h.callback(other, "edit:rem-1");
  await t.h.callback(other, "done:rem-1");
  assertEquals(t.reminders[0].status, "pending");
  assertEquals(
    t.sent.some((x) => x.kind === "edit" && x.text?.includes("Что изменить")),
    false,
  );
});

// --- /start и /list ----------------------------------------------------------

Deno.test("/start: приветствие с примерами", async () => {
  const t = setup();
  await t.h.start(t.io);
  assertEquals(t.sent.length, 1);
  assertEquals(t.sent[0].text!.includes("завтра в 11 встреча"), true);
});

Deno.test("/list: пусто → «Напоминаний пока нет»", async () => {
  const t = setup();
  await t.h.list(t.io);
  assertEquals(t.sent[0].text, "Напоминаний пока нет.");
});

// --- Текст → карточка --------------------------------------------------------

Deno.test("текст: показываем карточку, в базу НИЧЕГО не пишем, черновик — в сессии", async () => {
  const t = setup();
  await t.h.text(t.io, "через 3 минуты проверка");
  assertEquals(t.reminders.length, 0);
  assertEquals(t.sent[0].kind, "reply");
  assertEquals(t.sent[0].text, "Напомню <b>28.10 в 12:03</b>: проверка");
  assertEquals(t.sessions.get(CHAT), {
    state: "confirm",
    payload: {
      id: "draft1",
      text: "проверка",
      remind_at: "2026-10-28T09:03:00.000Z",
      adjusted: null,
      nag: null, // повтор по умолчанию выключен
      rrule: null, // расписания нет: разовое
    },
  });
});

Deno.test("текст: правила справились — Groq не вызываем", async () => {
  const t = setup({ llm: llmFails });
  await t.h.text(t.io, "завтра в 11 встреча");
  assertEquals(t.llmCalls(), 0);
});

Deno.test("текст: правила не поняли → спрашиваем Groq и показываем карточку", async () => {
  const t = setup({
    llm: () =>
      Promise.resolve({
        ok: true,
        text: "позвонить маме",
        remindAt: new Date("2026-10-30T08:00:00Z"),
        rrule: null,
        confidence: 0.9,
      }),
  });
  // «через пару дней в обед» правила не умеют (нет числа и точного времени) → уходит в Groq
  await t.h.text(t.io, "через пару дней в обед позвонить маме");
  assertEquals(t.llmCalls(), 1);
  assertEquals(t.sent[0].text, "Напомню <b>30.10 в 11:00</b>: позвонить маме");
});

Deno.test("текст: не поняли ни правила, ни Groq → вежливая просьба уточнить", async () => {
  const t = setup({ llm: llmFails });
  await t.h.text(t.io, "купить молоко");
  assertEquals(t.sent[0].text!.includes("Не понял, когда напомнить"), true);
  assertEquals(t.sessions.size, 0);
  assertEquals(t.reminders.length, 0);
});

Deno.test("текст: Groq не настроен (нет ключа) → просьба уточнить, без падения", async () => {
  const t = setup(); // llm не передан
  await t.h.text(t.io, "купить молоко");
  assertEquals(t.sent[0].text!.includes("Не понял, когда напомнить"), true);
});

Deno.test("текст: дата есть, а о чём напомнить — нет → спрашиваем текст, Groq не зовём", async () => {
  const t = setup({ llm: llmFails });
  await t.h.text(t.io, "завтра в 9 утра");
  assertEquals(t.sent[0].text!.includes("О чём напомнить"), true);
  assertEquals(t.llmCalls(), 0);
});

Deno.test("текст: повтор, который не умеем («каждый месяц»), → честно говорим", async () => {
  const t = setup({ llm: llmFails });
  await t.h.text(t.io, "каждый месяц 15 числа оплата");
  assertEquals(t.sent[0].text!.includes("пока умею только"), true);
  assertEquals(t.llmCalls(), 0);
});

Deno.test("текст: время сегодня прошло → в карточке предупреждение про «завтра»", async () => {
  const t = setup();
  await t.h.text(t.io, "сегодня в 9 зарядка");
  assertEquals(
    t.sent[0].text!.startsWith("Это время сегодня уже прошло"),
    true,
  );
});

// --- Кнопка «✅ OK» ----------------------------------------------------------

Deno.test("OK: сохраняем напоминание, чистим черновик, карточку превращаем в «Готово»", async () => {
  const t = setup();
  await t.h.text(t.io, "через 3 минуты проверка");
  await t.h.callback(t.io, buttonData(t.sent, "OK"));

  assertEquals(t.reminders.length, 1);
  assertEquals(t.reminders[0].chat_id, CHAT);
  assertEquals(t.reminders[0].text, "проверка");
  assertEquals(t.reminders[0].remind_at, "2026-10-28T09:03:00.000Z");
  assertEquals(t.reminders[0].rrule, null);
  assertEquals(t.sessions.size, 0);

  const edit = t.sent.find((s) => s.kind === "edit")!;
  assertEquals(edit.text, "✅ Готово! Напомню <b>28.10 в 12:03</b>: проверка");
  // остаётся единственная кнопка «Изменить»
  assertEquals(
    (edit.markup as { inline_keyboard: unknown[][] }).inline_keyboard.flat()
      .length,
    1,
  );
  assertEquals(t.sent.some((s) => s.kind === "answer"), true); // кнопка перестала «крутиться»
});

Deno.test("OK: двойное нажатие не создаёт дубль", async () => {
  const t = setup();
  await t.h.text(t.io, "через 3 минуты проверка");
  const data = buttonData(t.sent, "OK");
  await t.h.callback(t.io, data);
  await t.h.callback(t.io, data);
  assertEquals(t.reminders.length, 1);
});

Deno.test("OK со старой карточки (есть более новый черновик) → «устарела», ничего не сохраняем", async () => {
  const t = setup();
  await t.h.text(t.io, "через 3 минуты первое");
  const oldData = buttonData(t.sent, "OK");
  await t.h.text(t.io, "через 5 минут второе");
  await t.h.callback(t.io, oldData);
  assertEquals(t.reminders.length, 0);
  assertEquals(t.sent.at(-1)!.text!.includes("устарела"), true);
});

Deno.test("OK без черновика → «устарела»", async () => {
  const t = setup();
  await t.h.callback(t.io, "ok:draft1");
  assertEquals(t.reminders.length, 0);
  assertEquals(t.sent.at(-1)!.text!.includes("устарела"), true);
});

Deno.test("callback: мусорные данные кнопки игнорируем без ошибки", async () => {
  const t = setup();
  await t.h.callback(t.io, "hack:123");
  assertEquals(t.reminders.length, 0);
  assertEquals(t.sent.some((s) => s.kind === "answer"), true);
});

// --- Кнопка «🕐 Другое время» ------------------------------------------------

Deno.test("Другое время: ждём новое время, карточку превращаем в подсказку", async () => {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  await t.h.callback(t.io, buttonData(t.sent, "Другое время"));
  assertEquals(t.sessions.get(CHAT)!.state, "awaiting_time");
  const edit = t.sent.find((s) => s.kind === "edit")!;
  assertEquals(edit.text!.includes("встреча"), true);
  assertEquals(edit.text!.includes("Напиши новое время"), true);
  assertEquals(edit.markup, undefined);
});

Deno.test("Другое время → «завтра в 12»: текст берём прежний, время новое, снова карточка", async () => {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  await t.h.callback(t.io, buttonData(t.sent, "Другое время"));
  await t.h.text(t.io, "завтра в 12");
  assertEquals(t.sent.at(-1)!.text, "Напомню <b>29.10 в 12:00</b>: встреча");
  assertEquals(t.sessions.get(CHAT)!.state, "confirm");
  assertEquals(t.reminders.length, 0); // всё ещё не сохранено, ждём OK
});

Deno.test("Другое время → пользователь прислал и новый текст: берём его", async () => {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  await t.h.callback(t.io, buttonData(t.sent, "Другое время"));
  await t.h.text(t.io, "завтра в 12 созвон");
  assertEquals(t.sent.at(-1)!.text, "Напомню <b>29.10 в 12:00</b>: созвон");
});

Deno.test("Другое время → непонятное время: просим ещё раз, остаёмся в ожидании", async () => {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  await t.h.callback(t.io, buttonData(t.sent, "Другое время"));
  await t.h.text(t.io, "абракадабра");
  assertEquals(
    t.sent.at(-1)!.text!.includes("Не понял, когда напомнить"),
    true,
  );
  assertEquals(t.sessions.get(CHAT)!.state, "awaiting_time");
});

// --- Список и удаление -------------------------------------------------------

Deno.test("/list: показывает сохранённые, кнопка 🗑 удаляет и обновляет список", async () => {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  await t.h.text(t.io, "завтра в 12 созвон");
  await t.h.callback(t.io, buttonData(t.sent, "OK"));

  await t.h.list(t.io);
  const listMsg = t.sent.at(-1)!;
  assertEquals(
    listMsg.text,
    "Твои напоминания:\n1. 29.10 в 11:00 — встреча\n2. 29.10 в 12:00 — созвон",
  );

  await t.h.callback(t.io, buttonData(t.sent, "🗑 1"));
  assertEquals(t.reminders[0].status, "cancelled");
  const refreshed = t.sent.filter((s) => s.kind === "edit").at(-1)!;
  assertEquals(refreshed.text, "Твои напоминания:\n1. 29.10 в 12:00 — созвон");
});

Deno.test("удаление уже удалённого → «Уже удалено», без ошибки", async () => {
  const t = setup();
  await t.h.callback(t.io, "del:nonexistent");
  assertEquals(
    t.sent.some((s) => s.kind === "answer" && s.text === "Уже удалено"),
    true,
  );
});

// --- Не текст ----------------------------------------------------------------

Deno.test("фото/голос/файл: пока понимаем только текст", async () => {
  const t = setup();
  await t.h.unsupported(t.io);
  assertEquals(
    t.sent[0].text,
    "Пока понимаю только текст. Напиши, например: «завтра в 11 встреча».",
  );
});

// =============================================================================
// «Настойчивое» напоминание: 🔁 повтор на карточке и кнопка «✅ Готово»
// =============================================================================

// Открывает карточку «завтра в 11 встреча» и возвращает окружение.
async function withCard() {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  return t;
}
const lastEdit = (sent: Sent[]) =>
  sent.filter((s) => s.kind === "edit").at(-1)!;
const lastAnswer = (sent: Sent[]) =>
  sent.filter((s) => s.kind === "answer").at(-1)!;

Deno.test("повтор: на новой карточке есть кнопка «🔁 Повторять», повтор выключен", async () => {
  const t = await withCard();
  buttonData(t.sent, "Повторять"); // кнопка найдена (иначе тест упадёт)
  assertEquals((t.sessions.get(CHAT)!.payload as { nag: unknown }).nag, null);
});

Deno.test("повтор: «🔁 Повторять» включает значения по умолчанию (каждые 5 мин, 10 раз) и обновляет карточку на месте", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "Повторять"));
  assertEquals(
    (t.sessions.get(CHAT)!.payload as { nag: unknown }).nag,
    { intervalMin: 5, total: 10 },
  );
  const edit = lastEdit(t.sent);
  assertEquals(
    edit.text,
    "Напомню <b>29.10 в 11:00</b>: встреча\n" +
      "🔁 Повторю каждые 5 мин, всего 10 раз, пока не нажмёшь «Готово»",
  );
  buttonData(t.sent, "Выключить повтор"); // на карточке теперь кнопка выключения
  assertEquals(t.reminders.length, 0); // всё ещё не сохранено
});

Deno.test("повтор: повторное нажатие выключает повтор", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "Повторять"));
  await t.h.callback(t.io, buttonData(t.sent, "Выключить повтор"));
  assertEquals((t.sessions.get(CHAT)!.payload as { nag: unknown }).nag, null);
  assertEquals(lastEdit(t.sent).text, "Напомню <b>29.10 в 11:00</b>: встреча");
});

Deno.test("повтор: выбор интервала и количества меняет карточку", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "Повторять"));
  await t.h.callback(t.io, buttonData(t.sent, "30 мин"));
  await t.h.callback(t.io, buttonData(t.sent, "×20"));
  assertEquals(
    (t.sessions.get(CHAT)!.payload as { nag: unknown }).nag,
    { intervalMin: 30, total: 20 },
  );
  assertEquals(
    lastEdit(t.sent).text!.endsWith(
      "🔁 Повторю каждые 30 мин, всего 20 раз, пока не нажмёшь «Готово»",
    ),
    true,
  );
});

Deno.test("повтор: значения вне списка кнопок игнорируем (callback_data приходит извне)", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "Повторять"));
  const id = (t.sessions.get(CHAT)!.payload as { id: string }).id;
  await t.h.callback(t.io, `ivl:${id}:7`); // такого интервала нет на кнопках
  await t.h.callback(t.io, `cnt:${id}:1000`);
  await t.h.callback(t.io, `ivl:${id}:0`);
  assertEquals(
    (t.sessions.get(CHAT)!.payload as { nag: unknown }).nag,
    { intervalMin: 5, total: 10 },
  );
});

Deno.test("повтор: выбор интервала при выключенном повторе ничего не включает", async () => {
  const t = await withCard();
  const id = (t.sessions.get(CHAT)!.payload as { id: string }).id;
  await t.h.callback(t.io, `ivl:${id}:30`);
  assertEquals((t.sessions.get(CHAT)!.payload as { nag: unknown }).nag, null);
});

Deno.test("повтор: кнопки старой карточки → «устарела», черновик не меняется", async () => {
  const t = await withCard();
  const oldRep = buttonData(t.sent, "Повторять");
  await t.h.text(t.io, "завтра в 12 созвон"); // новая карточка, старая устарела
  await t.h.callback(t.io, oldRep);
  assertEquals((t.sessions.get(CHAT)!.payload as { nag: unknown }).nag, null);
  assertEquals(lastAnswer(t.sent).text!.includes("устарела"), true);
});

Deno.test("повтор: «OK» сохраняет серию в напоминании и показывает её в «Готово»", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "Повторять"));
  await t.h.callback(t.io, buttonData(t.sent, "10 мин"));
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  assertEquals(t.reminders.length, 1);
  assertEquals([t.reminders[0].nag_interval_min, t.reminders[0].nag_total], [
    10,
    10,
  ]);
  assertEquals(
    lastEdit(t.sent).text,
    "✅ Готово! Напомню <b>29.10 в 11:00</b>: встреча\n🔁 Повторю каждые 10 мин, всего 10 раз",
  );
});

Deno.test("повтор: без включённого повтора «OK» сохраняет обычное напоминание", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  assertEquals([t.reminders[0].nag_interval_min, t.reminders[0].nag_total], [
    null,
    null,
  ]);
});

Deno.test("повтор: настройки не теряются, если сменить время («Другое время»)", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "Повторять"));
  await t.h.callback(t.io, buttonData(t.sent, "30 мин"));
  await t.h.callback(t.io, buttonData(t.sent, "Другое время"));
  await t.h.text(t.io, "завтра в 12");
  const card = t.sent.filter((s) => s.kind === "reply").at(-1)!;
  assertEquals(
    card.text,
    "Напомню <b>29.10 в 12:00</b>: встреча\n" +
      "🔁 Повторю каждые 30 мин, всего 10 раз, пока не нажмёшь «Готово»",
  );
});

Deno.test("список: напоминание с повтором показано с отметкой 🔁", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "Повторять"));
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  await t.h.list(t.io);
  assertEquals(
    t.sent.filter((s) => s.kind === "reply").at(-1)!.text,
    "Твои напоминания:\n1. 29.10 в 11:00 — встреча 🔁 каждые 5 мин ×10",
  );
});

// --- Кнопка «✅ Готово» под сообщением серии -----------------------------------------

Deno.test("Готово: останавливает напоминание, сообщение превращается в «✅ Готово» без кнопок", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  await t.h.callback(t.io, "done:rem-1");
  assertEquals(t.reminders[0].status, "done");
  const edit = lastEdit(t.sent);
  assertEquals(edit.text, "✅ <b>Готово</b>\nвстреча");
  assertEquals(edit.markup, undefined);
  assertEquals(lastAnswer(t.sent).text, "Повторы остановлены");
});

Deno.test("Готово: повторное нажатие → «Уже остановлено», без ошибки", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  await t.h.callback(t.io, "done:rem-1");
  await t.h.callback(t.io, "done:rem-1");
  assertEquals(lastAnswer(t.sent).text, "Уже остановлено");
});

Deno.test("Готово: несуществующее напоминание → «Уже остановлено»", async () => {
  const t = setup();
  await t.h.callback(t.io, "done:nope");
  assertEquals(lastAnswer(t.sent).text, "Уже остановлено");
});

Deno.test("Готово: после остановки серия не показывается в /list", async () => {
  const t = await withCard();
  await t.h.callback(t.io, buttonData(t.sent, "Повторять"));
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  await t.h.callback(t.io, "done:rem-1");
  await t.h.list(t.io);
  assertEquals(
    t.sent.filter((s) => s.kind === "reply").at(-1)!.text,
    "Напоминаний пока нет.",
  );
});

// --- Правка напоминания из /list ---------------------------------------------

// Создаёт напоминание «завтра в 11 встреча» (29.10 11:00) и открывает меню правки.
async function withReminder() {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  await t.h.list(t.io);
  await t.h.callback(t.io, buttonData(t.sent, "✏️ 1"));
  return t;
}

Deno.test("правка: ✏️ открывает меню с текущим значением и кнопками", async () => {
  const t = await withReminder();
  const menu = t.sent.filter((s) => s.kind === "edit").at(-1)!;
  assertEquals(menu.text, "Что изменить?\n29.10 в 11:00 — встреча");
  buttonData(t.sent, "Текст");
  buttonData(t.sent, "Время");
  buttonData(t.sent, "К списку");
});

Deno.test("правка: ✏️ для уже сработавшего/чужого → «Уже сработало», меню нет", async () => {
  const t = setup();
  await t.h.callback(t.io, "edit:nonexistent");
  assertEquals(
    t.sent.some((s) =>
      s.kind === "answer" && s.text === "Уже сработало или удалено"
    ),
    true,
  );
  assertEquals(t.sent.some((s) => s.kind === "edit"), false);
});

Deno.test("правка текста: следующее сообщение заменяет текст, время не меняется", async () => {
  const t = await withReminder();
  const remindAt = t.reminders[0].remind_at;
  await t.h.callback(t.io, buttonData(t.sent, "Текст"));
  await t.h.text(t.io, "встреча с <Петей>");
  assertEquals(t.reminders[0].text, "встреча с <Петей>");
  assertEquals(t.reminders[0].remind_at, remindAt);
  assertEquals(
    t.sent.filter((s) => s.kind === "reply").at(-1)!.text,
    "✅ Обновлено: 29.10 в 11:00 — встреча с &lt;Петей&gt;",
  );
  assertEquals(t.sessions.has(CHAT), false); // ожидание закончилось
  buttonData(t.sent, "К списку");
});

Deno.test("правка текста: пустой/пробельный текст не принимаем и остаёмся в ожидании", async () => {
  const t = await withReminder();
  await t.h.callback(t.io, buttonData(t.sent, "Текст"));
  await t.h.text(t.io, "   ");
  assertEquals(t.reminders[0].text, "встреча");
  assertEquals(t.sessions.get(CHAT)?.state, "edit_text");
});

Deno.test("правка времени: «завтра в 12» меняет время, текст прежний, серия обнуляется", async () => {
  const t = await withReminder();
  t.reminders[0].nag_sent = 3;
  await t.h.callback(t.io, buttonData(t.sent, "Время"));
  await t.h.text(t.io, "завтра в 12");
  assertEquals(t.reminders[0].remind_at, "2026-10-29T09:00:00.000Z");
  assertEquals(t.reminders[0].text, "встреча");
  assertEquals(t.reminders[0].nag_sent, 0);
  assertEquals(
    t.sent.filter((s) => s.kind === "reply").at(-1)!.text,
    "✅ Обновлено: 29.10 в 12:00 — встреча",
  );
  assertEquals(t.sessions.has(CHAT), false);
});

Deno.test("правка времени: «завтра в 12 новый текст» меняет оба", async () => {
  const t = await withReminder();
  await t.h.callback(t.io, buttonData(t.sent, "Время"));
  await t.h.text(t.io, "завтра в 12 созвон");
  assertEquals(t.reminders[0].remind_at, "2026-10-29T09:00:00.000Z");
  assertEquals(t.reminders[0].text, "созвон");
});

Deno.test("правка времени: не поняли → переспрашиваем, ничего не меняем, ждём дальше", async () => {
  const t = await withReminder();
  const before = { ...t.reminders[0] };
  await t.h.callback(t.io, buttonData(t.sent, "Время"));
  await t.h.text(t.io, "когда-нибудь");
  assertEquals(t.reminders[0], before);
  assertEquals(t.sessions.get(CHAT)?.state, "edit_time");
});

Deno.test("правка времени: прошедшее сегодня → переносим на завтра и говорим об этом", async () => {
  const t = await withReminder();
  await t.h.callback(t.io, buttonData(t.sent, "Время"));
  await t.h.text(t.io, "сегодня в 10:00"); // сейчас 12:00 по Москве
  assertEquals(t.reminders[0].remind_at, "2026-10-29T07:00:00.000Z");
  assertEquals(
    t.sent.filter((s) => s.kind === "reply").at(-1)!.text!.includes("завтра"),
    true,
  );
});

Deno.test("правка: напоминание успело сработать → «Уже сработало», правка не применяется", async () => {
  const t = await withReminder();
  await t.h.callback(t.io, buttonData(t.sent, "Текст"));
  t.reminders[0].status = "sent"; // tick опередил
  await t.h.text(t.io, "новый текст");
  assertEquals(t.reminders[0].text, "встреча");
  assertEquals(
    t.sent.filter((s) => s.kind === "reply").at(-1)!.text,
    "Это напоминание уже сработало или удалено, изменить нельзя.",
  );
  assertEquals(t.sessions.has(CHAT), false);
});

Deno.test("правка: «К списку» возвращает список", async () => {
  const t = await withReminder();
  await t.h.callback(t.io, buttonData(t.sent, "К списку"));
  assertEquals(
    t.sent.filter((s) => s.kind === "edit").at(-1)!.text,
    "Твои напоминания:\n1. 29.10 в 11:00 — встреча",
  );
});

// --- Правка до и после «OK» --------------------------------------------------

Deno.test("до OK: «✏️ Текст» на карточке меняет текст, время и повтор сохраняются", async () => {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  await t.h.callback(t.io, buttonData(t.sent, "Повторять"));
  await t.h.callback(t.io, buttonData(t.sent, "Текст"));
  assertEquals(t.sessions.get(CHAT)?.state, "draft_text");
  await t.h.text(t.io, "встреча с <Петей>");
  const card = t.sent.filter((s) => s.kind === "reply").at(-1)!;
  assertEquals(
    card.text!.startsWith(
      "Напомню <b>29.10 в 11:00</b>: встреча с &lt;Петей&gt;",
    ),
    true,
  );
  assertEquals(card.text!.includes("🔁 Повторю"), true);
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  assertEquals(t.reminders[0].text, "встреча с <Петей>");
  assertEquals(t.reminders[0].nag_total, 10);
});

Deno.test("до OK: пустой текст не принимаем, старая карточка после правки устаревает", async () => {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  const oldOk = buttonData(t.sent, "OK");
  await t.h.callback(t.io, buttonData(t.sent, "Текст"));
  await t.h.text(t.io, "   ");
  assertEquals(t.sessions.get(CHAT)?.state, "draft_text");
  await t.h.text(t.io, "новый");
  await t.h.callback(t.io, oldOk); // кнопка старой карточки
  assertEquals(t.reminders.length, 0);
});

Deno.test("до OK: «✏️ Текст» на устаревшей карточке → «устарела»", async () => {
  const t = setup();
  await t.h.callback(t.io, "dtxt:zzzz");
  assertEquals(
    t.sent.some((s) => s.kind === "answer" && s.text?.includes("устарела")),
    true,
  );
});

Deno.test("после OK: под «Готово!» есть «✏️ Изменить» и она открывает меню правки", async () => {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  assertEquals(buttonData(t.sent, "Изменить"), "edit:rem-1");
  await t.h.callback(t.io, buttonData(t.sent, "Изменить"));
  assertEquals(
    t.sent.filter((s) => s.kind === "edit").at(-1)!.text,
    "Что изменить?\n29.10 в 11:00 — встреча",
  );
});

Deno.test("правка текста: подсказка показывает старый текст в <code> (копируется нажатием), экранированный", async () => {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча <Петя>");
  await t.h.callback(t.io, buttonData(t.sent, "Текст"));
  const prompt = t.sent.filter((s) => s.kind === "edit").at(-1)!.text!;
  assertEquals(prompt.includes("<code>встреча &lt;Петя&gt;</code>"), true);
});

// --- Snooze ------------------------------------------------------------------

// Напоминание «сработало»: статус sent, сообщение у пользователя уже есть.
async function withFired() {
  const t = setup();
  await t.h.text(t.io, "завтра в 11 встреча");
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  t.reminders[0].status = "sent";
  t.reminders[0].nag_sent = 3;
  return t;
}

Deno.test("snooze: «+10 мин» и «+1 час» считаются от «сейчас», запись снова pending, серия с нуля", async () => {
  const t = await withFired();
  await t.h.callback(t.io, "snz:rem-1:10");
  assertEquals(t.reminders[0].status, "pending");
  assertEquals(t.reminders[0].remind_at, "2026-10-28T09:10:00.000Z");
  assertEquals(t.reminders[0].nag_sent, 0);
  assertEquals(
    t.sent.filter((s) => s.kind === "edit").at(-1)!.text,
    "💤 <b>Отложено до 28.10 в 12:10</b>\nвстреча",
  );
  assertEquals(
    t.sent.filter((s) => s.kind === "edit").at(-1)!.markup,
    undefined,
  );
  await t.h.callback(t.io, "snz:rem-1:60");
  assertEquals(t.reminders[0].remind_at, "2026-10-28T10:00:00.000Z");
});

Deno.test("snooze: «Завтра» = завтра в 09:00 по Москве (default_time)", async () => {
  const t = await withFired();
  await t.h.callback(t.io, "snz:rem-1:1440");
  assertEquals(t.reminders[0].remind_at, "2026-10-29T06:00:00.000Z");
});

Deno.test("snooze: левое значение, чужой чат, отменённое и закрытое — ничего не меняют", async () => {
  const t = await withFired();
  const before = t.reminders[0].remind_at;
  await t.h.callback(t.io, "snz:rem-1:5"); // нет такой кнопки
  await t.h.callback({ ...t.io, chatId: CHAT + 1 }, "snz:rem-1:10"); // чужой
  assertEquals(t.reminders[0].remind_at, before);
  assertEquals(t.reminders[0].status, "sent");
  t.reminders[0].status = "cancelled";
  await t.h.callback(t.io, "snz:rem-1:10");
  assertEquals(t.reminders[0].status, "cancelled");
  assertEquals(
    t.sent.some((s) => s.kind === "answer" && s.text === "Уже неактуально"),
    true,
  );
});

// --- Повторы по расписанию ---------------------------------------------------

// Создаёт «каждый день в 9 зарядка» и подтверждает; NOW = среда 12:00 МСК → первое 29.10 09:00.
async function withSchedule() {
  const t = setup();
  await t.h.text(t.io, "каждый день в 9 зарядка");
  return t;
}

Deno.test("расписание: карточка показывает повтор, OK сохраняет rrule, финал тоже про повтор", async () => {
  const t = await withSchedule();
  const card = t.sent.filter((s) => s.kind === "reply").at(-1)!;
  assertEquals(
    card.text,
    "Напомню <b>29.10 в 09:00</b>: зарядка\n📆 Повторяется каждый день в 09:00",
  );
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  assertEquals(t.reminders[0].rrule, "FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
  assertEquals(t.reminders[0].remind_at, "2026-10-29T06:00:00.000Z");
  const done = t.sent.filter((s) => s.kind === "edit").at(-1)!;
  assertEquals(done.text!.includes("📆 Повторяется каждый день в 09:00"), true);
});

Deno.test("расписание: «✅ Готово» не закрывает, а переносит на следующее срабатывание", async () => {
  const t = await withSchedule();
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  t.reminders[0].status = "sent"; // сработало (сегодня уже 12:00 МСК)
  await t.h.callback(t.io, "done:rem-1");
  assertEquals(t.reminders[0].status, "pending");
  assertEquals(t.reminders[0].remind_at, "2026-10-29T06:00:00.000Z");
  const msg = t.sent.filter((s) => s.kind === "edit").at(-1)!.text!;
  assertEquals(msg.includes("Готово"), true);
  assertEquals(msg.includes("Следующее: 29.10 в 09:00"), true);
});

Deno.test("расписание: «⛔ Прекратить повторы» закрывает насовсем", async () => {
  const t = await withSchedule();
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  await t.h.callback(t.io, "stop:rem-1");
  assertEquals(t.reminders[0].status, "done");
  assertEquals(
    t.sent.filter((s) => s.kind === "edit").at(-1)!.text,
    "⛔ <b>Повторы прекращены</b>\nзарядка",
  );
  await t.h.callback(t.io, "stop:rem-1"); // повторное нажатие
  assertEquals(
    t.sent.some((s) => s.kind === "answer" && s.text === "Уже остановлено"),
    true,
  );
});

Deno.test("расписание: правка времени с «каждый…» заменяет расписание, без — двигает только ближайшее", async () => {
  const t = await withSchedule();
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  await t.h.list(t.io);
  await t.h.callback(t.io, buttonData(t.sent, "✏️ 1"));
  await t.h.callback(t.io, buttonData(t.sent, "Время"));
  await t.h.text(t.io, "завтра в 10"); // без «каждый»: только ближайшее срабатывание
  assertEquals(t.reminders[0].remind_at, "2026-10-29T07:00:00.000Z");
  assertEquals(t.reminders[0].rrule, "FREQ=DAILY;BYHOUR=9;BYMINUTE=0");

  await t.h.callback(t.io, buttonData(t.sent, "К списку"));
  await t.h.callback(t.io, buttonData(t.sent, "✏️ 1"));
  await t.h.callback(t.io, buttonData(t.sent, "Время"));
  await t.h.text(t.io, "по будням в 8"); // новое расписание
  assertEquals(
    t.reminders[0].rrule,
    "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0",
  );
  assertEquals(t.reminders[0].remind_at, "2026-10-29T05:00:00.000Z");
});

Deno.test("расписание: «Другое время» на карточке с фразой без «каждый» делает разовое", async () => {
  const t = await withSchedule();
  await t.h.callback(t.io, buttonData(t.sent, "Другое время"));
  await t.h.text(t.io, "завтра в 12");
  await t.h.callback(t.io, buttonData(t.sent, "OK"));
  assertEquals(t.reminders[0].rrule, null);
});
