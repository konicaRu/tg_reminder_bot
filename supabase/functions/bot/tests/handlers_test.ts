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
  parseAllowedId,
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
      } as Reminder;
      reminders.push(row);
      return Promise.resolve(row);
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

Deno.test("whitelist: пускаем только владельца", () => {
  assertEquals(isAllowed(CHAT, CHAT), true);
  assertEquals(isAllowed(111, CHAT), false);
  assertEquals(isAllowed(undefined, CHAT), false);
});

Deno.test("ALLOWED_USER_ID: число принимаем, мусор и пустое — ошибка (бот не стартует открытым)", () => {
  assertEquals(parseAllowedId("234320036"), 234320036);
  for (const bad of [undefined, "", "abc", "0", "-5"]) {
    let threw = false;
    try {
      parseAllowedId(bad);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  }
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

Deno.test("текст: повтор («каждый день») → честно говорим, что пока не умеем", async () => {
  const t = setup({ llm: llmFails });
  await t.h.text(t.io, "каждый день в 9 зарядка");
  assertEquals(
    t.sent[0].text!.includes("Повторяющиеся напоминания пока не умею"),
    true,
  );
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
  assertEquals(edit.markup, undefined); // кнопки убраны
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
