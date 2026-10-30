// Тесты хелперов Telegram: как бот показывает даты, карточку подтверждения,
// список напоминаний и как кодирует данные кнопок.
// Здесь нет сети и базы: все функции «чистые» (на тот же вход всегда тот же выход).

import { deepStrictEqual as assertEquals } from "node:assert";
import {
  buildConfirmCard,
  buildEditMenu,
  buildListMessage,
  buildReminderKeyboard,
  buildReminderMessage,
  buildSeriesStoppedMessage,
  buildSnoozedMessage,
  buildStoppedMessage,
  captionFor,
  clipText,
  decodeCallback,
  DEFAULT_NAG,
  encodeCallback,
  escapeHtml,
  formatWhen,
  isMediaMessage,
} from "../telegram.ts";

const TZ = "Europe/Moscow";
const NOW = new Date("2026-10-28T09:00:00Z"); // среда, 12:00 по Москве

// --- Формат даты для человека ------------------------------------------------

Deno.test("formatWhen: дата и время в поясе пользователя", () => {
  // 08:00 UTC = 11:00 по Москве
  assertEquals(
    formatWhen(new Date("2026-10-29T08:00:00Z"), TZ, NOW),
    "29.10 в 11:00",
  );
});

Deno.test("formatWhen: нули спереди у дня, месяца, часа и минут", () => {
  assertEquals(
    formatWhen(new Date("2026-11-03T06:05:00Z"), TZ, NOW),
    "03.11 в 09:05",
  );
});

Deno.test("formatWhen: год показываем только если он не текущий", () => {
  assertEquals(
    formatWhen(new Date("2027-10-03T06:00:00Z"), TZ, NOW),
    "03.10.2027 в 09:00",
  );
});

Deno.test("formatWhen: учитывает пояс (Екатеринбург, UTC+5)", () => {
  assertEquals(
    formatWhen(new Date("2026-10-29T06:00:00Z"), "Asia/Yekaterinburg", NOW),
    "29.10 в 11:00",
  );
});

Deno.test("formatWhen: после полуночи по местному времени дата следующая", () => {
  // 22:30 UTC = 01:30 по Москве уже следующего дня
  assertEquals(
    formatWhen(new Date("2026-10-28T22:30:00Z"), TZ, NOW),
    "29.10 в 01:30",
  );
});

// --- Защита от «ломающих» символов -------------------------------------------

Deno.test("escapeHtml: экранирует < > &", () => {
  assertEquals(
    escapeHtml("<b>Тор & Ко</b>"),
    "&lt;b&gt;Тор &amp; Ко&lt;/b&gt;",
  );
});

// --- Данные кнопок (callback_data) -------------------------------------------

Deno.test("callback: кодирование и разбор туда-обратно", () => {
  assertEquals(encodeCallback({ action: "ok", id: "a1b2c3d4" }), "ok:a1b2c3d4");
  assertEquals(decodeCallback("ok:a1b2c3d4"), { action: "ok", id: "a1b2c3d4" });
  assertEquals(decodeCallback("other:a1b2c3d4"), {
    action: "other",
    id: "a1b2c3d4",
  });
});

Deno.test("callback: удаление хранит uuid и укладывается в лимит Telegram (64 байта)", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const data = encodeCallback({ action: "del", id: uuid });
  assertEquals(data, `del:${uuid}`);
  assertEquals(new TextEncoder().encode(data).length <= 64, true);
  assertEquals(decodeCallback(data), { action: "del", id: uuid });
});

Deno.test("callback: мусор и неизвестные действия → null", () => {
  assertEquals(decodeCallback("garbage"), null);
  assertEquals(decodeCallback("hack:123"), null);
  assertEquals(decodeCallback("ok:"), null);
  assertEquals(decodeCallback(""), null);
});

// --- Карточка подтверждения --------------------------------------------------

Deno.test("карточка: текст и две кнопки [OK] [Другое время]", () => {
  const card = buildConfirmCard({
    text: "встреча",
    remindAt: new Date("2026-10-29T08:00:00Z"),
    draftId: "a1b2c3d4",
    timezone: TZ,
    now: NOW,
  });
  assertEquals(card.text, "Напомню <b>29.10 в 11:00</b>: встреча");
  assertEquals(card.reply_markup.inline_keyboard, [
    [
      { text: "✅ OK", callback_data: "ok:a1b2c3d4" },
      { text: "🕐 Другое время", callback_data: "other:a1b2c3d4" },
    ],
    // второй ряд: включить повторные напоминания
    [
      { text: "🔁 Повторять", callback_data: "rep:a1b2c3d4" },
      { text: "✏️ Текст", callback_data: "dtxt:a1b2c3d4" },
    ],
  ]);
});

Deno.test("карточка: текст пользователя экранируется", () => {
  const card = buildConfirmCard({
    text: "<script>alert(1)</script> & всё",
    remindAt: new Date("2026-10-29T08:00:00Z"),
    draftId: "a1b2c3d4",
    timezone: TZ,
    now: NOW,
  });
  assertEquals(card.text.includes("<script>"), false);
  assertEquals(card.text.includes("&lt;script&gt;"), true);
  assertEquals(card.text.includes("&amp; всё"), true);
});

Deno.test("карточка: если время перенесли на завтра, об этом сказано явно", () => {
  const card = buildConfirmCard({
    text: "зарядка",
    remindAt: new Date("2026-10-29T06:00:00Z"),
    draftId: "a1b2c3d4",
    timezone: TZ,
    now: NOW,
    adjusted: "tomorrow",
  });
  assertEquals(
    card.text,
    "Это время сегодня уже прошло, поэтому предлагаю завтра.\n" +
      "Напомню <b>29.10 в 09:00</b>: зарядка",
  );
});

// --- Список напоминаний (/list) ----------------------------------------------

Deno.test("список: пустой → понятное сообщение и без кнопок", () => {
  const msg = buildListMessage([], TZ, NOW);
  assertEquals(msg.text, "Напоминаний пока нет.");
  assertEquals(msg.reply_markup, undefined);
});

Deno.test("список: нумерация, даты в поясе пользователя и кнопки 🗑 с id", () => {
  const msg = buildListMessage(
    [
      { id: "id-1", text: "встреча", remind_at: "2026-10-29T08:00:00Z" },
      {
        id: "id-2",
        text: "позвонить <маме>",
        remind_at: "2026-11-03T06:00:00Z",
      },
    ],
    TZ,
    NOW,
  );
  assertEquals(
    msg.text,
    "Твои напоминания:\n1. 29.10 в 11:00 — встреча\n2. 03.11 в 09:00 — позвонить &lt;маме&gt;",
  );
  // первый ряд — ✏️ (править), второй — 🗑 (удалить)
  assertEquals(msg.reply_markup!.inline_keyboard, [
    [
      { text: "✏️ 1", callback_data: "edit:id-1" },
      { text: "✏️ 2", callback_data: "edit:id-2" },
    ],
    [
      { text: "🗑 1", callback_data: "del:id-1" },
      { text: "🗑 2", callback_data: "del:id-2" },
    ],
  ]);
});

Deno.test("список: больше 20 штук → показываем 20 и предупреждаем", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `id-${i}`,
    text: `дело ${i}`,
    remind_at: "2026-10-29T08:00:00Z",
  }));
  const msg = buildListMessage(many, TZ, NOW);
  assertEquals(msg.text.split("\n").filter((l) => /^\d+\./.test(l)).length, 20);
  assertEquals(msg.text.includes("Показаны ближайшие 20 из 25"), true);
  // кнопки ✏️ и 🗑 — по 5 в ряд, каждых по 20
  const rows = msg.reply_markup!.inline_keyboard;
  assertEquals(rows.flat().length, 40);
  assertEquals(rows.every((r) => r.length <= 5), true);
});

// --- Сообщение, когда напоминание сработало ----------------------------------

Deno.test("сообщение-напоминание: заголовок и текст, текст экранирован", () => {
  assertEquals(
    buildReminderMessage("встреча"),
    "⏰ <b>Напоминание</b>\nвстреча",
  );
  assertEquals(
    buildReminderMessage("a < b"),
    "⏰ <b>Напоминание</b>\na &lt; b",
  );
});

// =============================================================================
// «Настойчивое» напоминание: повторять каждые N минут, всего M раз, пока не «Готово»
// =============================================================================

Deno.test("настойчивое: значения по умолчанию — каждые 5 минут, всего 10 раз", () => {
  assertEquals(DEFAULT_NAG, { intervalMin: 5, total: 10 });
});

// --- Данные кнопок с числом (интервал, количество) ---------------------------

Deno.test("callback: действия с числом кодируются и разбираются", () => {
  assertEquals(
    encodeCallback({ action: "ivl", id: "a1b2c3d4", arg: 30 }),
    "ivl:a1b2c3d4:30",
  );
  assertEquals(decodeCallback("ivl:a1b2c3d4:30"), {
    action: "ivl",
    id: "a1b2c3d4",
    arg: 30,
  });
  assertEquals(decodeCallback("cnt:a1b2c3d4:10"), {
    action: "cnt",
    id: "a1b2c3d4",
    arg: 10,
  });
});

Deno.test("callback: rep и done — без числа", () => {
  assertEquals(decodeCallback("rep:a1b2c3d4"), {
    action: "rep",
    id: "a1b2c3d4",
  });
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  assertEquals(decodeCallback(`done:${uuid}`), { action: "done", id: uuid });
  assertEquals(new TextEncoder().encode(`done:${uuid}`).length <= 64, true);
});

Deno.test("callback: число обязательно там, где нужно, и запрещено там, где не нужно", () => {
  assertEquals(decodeCallback("ivl:a1b2c3d4"), null); // нет числа
  assertEquals(decodeCallback("cnt:a1b2c3d4:"), null);
  assertEquals(decodeCallback("ivl:a1b2c3d4:abc"), null); // не число
  assertEquals(decodeCallback("ivl:a1b2c3d4:-5"), null);
  assertEquals(decodeCallback("ok:a1b2c3d4:5"), null); // лишнее число
  assertEquals(decodeCallback("rep:a1b2c3d4:1"), null);
});

// --- Карточка с включённым повтором ------------------------------------------

const cardWithNag = (nag: { intervalMin: number; total: number }) =>
  buildConfirmCard({
    text: "принять лекарство",
    remindAt: new Date("2026-10-29T08:00:00Z"),
    draftId: "a1b2c3d4",
    timezone: TZ,
    now: NOW,
    nag,
  });

Deno.test("карточка с повтором: пояснение в тексте", () => {
  const card = cardWithNag({ intervalMin: 5, total: 10 });
  assertEquals(
    card.text,
    "Напомню <b>29.10 в 11:00</b>: принять лекарство\n" +
      "🔁 Повторю каждые 5 мин, всего 10 раз, пока не нажмёшь «Готово»",
  );
});

Deno.test("карточка с повтором: кнопки OK/Другое время, «Выключить повтор», интервалы и количество с отметкой выбранного", () => {
  const card = cardWithNag({ intervalMin: 5, total: 10 });
  assertEquals(card.reply_markup.inline_keyboard, [
    [
      { text: "✅ OK", callback_data: "ok:a1b2c3d4" },
      { text: "🕐 Другое время", callback_data: "other:a1b2c3d4" },
    ],
    [
      { text: "🔁 Выключить повтор", callback_data: "rep:a1b2c3d4" },
      { text: "✏️ Текст", callback_data: "dtxt:a1b2c3d4" },
    ],
    [
      { text: "5 мин ✓", callback_data: "ivl:a1b2c3d4:5" },
      { text: "10 мин", callback_data: "ivl:a1b2c3d4:10" },
      { text: "30 мин", callback_data: "ivl:a1b2c3d4:30" },
      { text: "1 час", callback_data: "ivl:a1b2c3d4:60" },
    ],
    [
      { text: "×3", callback_data: "cnt:a1b2c3d4:3" },
      { text: "×5", callback_data: "cnt:a1b2c3d4:5" },
      { text: "×10 ✓", callback_data: "cnt:a1b2c3d4:10" },
      { text: "×20", callback_data: "cnt:a1b2c3d4:20" },
    ],
  ]);
});

Deno.test("карточка с повтором: отметка ✓ следует за выбором, склонение «раза/раз», «1 час»", () => {
  const card = cardWithNag({ intervalMin: 60, total: 3 });
  assertEquals(
    card.text.endsWith(
      "🔁 Повторю каждые 1 час, всего 3 раза, пока не нажмёшь «Готово»",
    ),
    true,
  );
  const rows = card.reply_markup.inline_keyboard;
  assertEquals(rows[2].map((b) => b.text), [
    "5 мин",
    "10 мин",
    "30 мин",
    "1 час ✓",
  ]);
  assertEquals(rows[3].map((b) => b.text), ["×3 ✓", "×5", "×10", "×20"]);
});

Deno.test("карточка: все кнопки укладываются в лимит callback_data (64 байта)", () => {
  const card = buildConfirmCard({
    text: "x",
    remindAt: new Date("2026-10-29T08:00:00Z"),
    draftId: "abcdefgh",
    timezone: TZ,
    now: NOW,
    nag: { intervalMin: 5, total: 10 },
  });
  for (const b of card.reply_markup.inline_keyboard.flat()) {
    assertEquals(new TextEncoder().encode(b.callback_data).length <= 64, true);
  }
});

// --- Сообщение-повтор и кнопка «Готово» --------------------------------------

Deno.test("сообщение серии: «(k из N)» в заголовке", () => {
  assertEquals(
    buildReminderMessage("принять лекарство", { index: 2, total: 10 }),
    "⏰ <b>Напоминание</b> (2 из 10)\nпринять лекарство",
  );
  // без серии — как раньше
  assertEquals(
    buildReminderMessage("встреча"),
    "⏰ <b>Напоминание</b>\nвстреча",
  );
});

Deno.test("кнопки под напоминанием: snooze (+10 мин, +1 час, Завтра) и «Готово», все несут id", () => {
  assertEquals(buildReminderKeyboard("rem-1"), {
    inline_keyboard: [
      [
        { text: "+10 мин", callback_data: "snz:rem-1:10" },
        { text: "+1 час", callback_data: "snz:rem-1:60" },
        { text: "Завтра", callback_data: "snz:rem-1:1440" },
      ],
      [{ text: "✅ Готово", callback_data: "done:rem-1" }],
    ],
  });
});

Deno.test("snooze: callback разбирается, uuid укладывается в 64 байта", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  assertEquals(decodeCallback(`snz:${uuid}:60`), {
    action: "snz",
    id: uuid,
    arg: 60,
  });
  for (const b of buildReminderKeyboard(uuid).inline_keyboard.flat()) {
    assertEquals(new TextEncoder().encode(b.callback_data).length <= 64, true);
  }
});

Deno.test("сообщение после snooze: «💤 Отложено до …» с экранированным текстом", () => {
  assertEquals(
    buildSnoozedMessage("a < b", "29.10 в 12:30"),
    "💤 <b>Отложено до 29.10 в 12:30</b>\na &lt; b",
  );
});

Deno.test("после «Готово» сообщение превращается в «✅ Готово» с текстом (экранированным)", () => {
  assertEquals(buildStoppedMessage("a < b"), "✅ <b>Готово</b>\na &lt; b");
});

// --- /list: отметка серии ----------------------------------------------------

Deno.test("список: у напоминания с повтором есть отметка 🔁 и счётчик отправленных", () => {
  const msg = buildListMessage(
    [
      { id: "id-1", text: "обычное", remind_at: "2026-10-29T08:00:00Z" },
      {
        id: "id-2",
        text: "лекарство",
        remind_at: "2026-10-29T09:00:00Z",
        nag_interval_min: 5,
        nag_total: 10,
        nag_sent: 0,
      },
      {
        id: "id-3",
        text: "вода",
        remind_at: "2026-10-29T10:00:00Z",
        nag_interval_min: 60,
        nag_total: 3,
        nag_sent: 2,
      },
    ],
    TZ,
    NOW,
  );
  assertEquals(
    msg.text,
    "Твои напоминания:\n" +
      "1. 29.10 в 11:00 — обычное\n" +
      "2. 29.10 в 12:00 — лекарство 🔁 каждые 5 мин ×10\n" +
      "3. 29.10 в 13:00 — вода 🔁 каждые 1 час ×3 (отправлено 2)",
  );
});

// --- Редактирование: меню и данные кнопок ------------------------------------

Deno.test("меню правки: что за напоминание и кнопки Текст / Время / К списку", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  const menu = buildEditMenu(
    { id: uuid, text: "позвонить <маме>", remind_at: "2026-10-29T08:00:00Z" },
    TZ,
    NOW,
  );
  assertEquals(
    menu.text,
    "Что изменить?\n29.10 в 11:00 — позвонить &lt;маме&gt;",
  );
  assertEquals(menu.reply_markup.inline_keyboard, [
    [
      { text: "✏️ Текст", callback_data: `etxt:${uuid}` },
      { text: "🕐 Время", callback_data: `etime:${uuid}` },
    ],
    [{ text: "📎 Вложение", callback_data: `eatt:${uuid}` }],
    [{ text: "⬅️ К списку", callback_data: "list:all" }],
  ]);
  // Telegram принимает callback_data не длиннее 64 байт
  for (const b of menu.reply_markup.inline_keyboard.flat()) {
    assertEquals(new TextEncoder().encode(b.callback_data).length <= 64, true);
  }
});

Deno.test("callback: новые действия edit / etxt / etime / list разбираются", () => {
  assertEquals(decodeCallback("edit:abc-1"), { action: "edit", id: "abc-1" });
  assertEquals(decodeCallback("etxt:abc-1"), { action: "etxt", id: "abc-1" });
  assertEquals(decodeCallback("etime:abc-1"), { action: "etime", id: "abc-1" });
  assertEquals(decodeCallback("dtxt:a1b2"), { action: "dtxt", id: "a1b2" });
  assertEquals(decodeCallback("list:all"), { action: "list", id: "all" });
  assertEquals(decodeCallback("edit:"), null);
  assertEquals(decodeCallback("edit:a b"), null);
});

// --- Повторы по расписанию ---------------------------------------------------

const WD_RULE = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0";

Deno.test("карточка с расписанием: строка «📆 Повторяется …», кнопки как обычно", () => {
  const card = buildConfirmCard({
    text: "зарядка",
    remindAt: new Date("2026-10-29T06:00:00Z"),
    draftId: "a1b2c3d4",
    timezone: TZ,
    now: NOW,
    rrule: WD_RULE,
  });
  assertEquals(
    card.text,
    "Напомню <b>29.10 в 09:00</b>: зарядка\n📆 Повторяется по будням в 09:00",
  );
  assertEquals(card.reply_markup.inline_keyboard[0][0].text, "✅ OK");
});

Deno.test("/list: у напоминания с расписанием отметка 📆", () => {
  const msg = buildListMessage(
    [{
      id: "id-1",
      text: "зарядка",
      remind_at: "2026-10-29T06:00:00Z",
      rrule: WD_RULE,
    }],
    TZ,
    NOW,
  );
  assertEquals(
    msg.text,
    "Твои напоминания:\n1. 29.10 в 09:00 — зарядка 📆 по будням в 09:00",
  );
});

Deno.test("кнопки у повторяющегося: добавляется «⛔ Прекратить повторы»", () => {
  assertEquals(buildReminderKeyboard("rem-1", { repeating: true }), {
    inline_keyboard: [
      [
        { text: "+10 мин", callback_data: "snz:rem-1:10" },
        { text: "+1 час", callback_data: "snz:rem-1:60" },
        { text: "Завтра", callback_data: "snz:rem-1:1440" },
      ],
      [
        { text: "✅ Готово", callback_data: "done:rem-1" },
        { text: "⛔ Прекратить повторы", callback_data: "stop:rem-1" },
      ],
    ],
  });
  assertEquals(decodeCallback("stop:abc"), { action: "stop", id: "abc" });
});

Deno.test("сообщения про расписание: «Готово» и «Повторы прекращены»", () => {
  assertEquals(
    buildSeriesStoppedMessage("a < b"),
    "⛔ <b>Повторы прекращены</b>\na &lt; b",
  );
});

// --- Голосовые: «Я услышал» --------------------------------------------------

Deno.test("карточка: для голосового первой строкой «🎙 Я услышал: «…»» (экранировано)", () => {
  const card = buildConfirmCard({
    text: "встреча",
    remindAt: new Date("2026-10-29T08:00:00Z"),
    draftId: "a1b2c3d4",
    timezone: TZ,
    now: NOW,
    heard: "завтра в 11 встреча <b>",
  });
  assertEquals(
    card.text,
    "🎙 Я услышал: «завтра в 11 встреча &lt;b&gt;»\nНапомню <b>29.10 в 11:00</b>: встреча",
  );
});

// --- Вложения ----------------------------------------------------------------

Deno.test("карточка с вложением: строка «📎 Вложение: фото/документ»", () => {
  const base = {
    text: "отдать",
    remindAt: new Date("2026-10-29T07:00:00Z"),
    draftId: "a1b2c3d4",
    timezone: TZ,
    now: NOW,
  };
  assertEquals(
    buildConfirmCard({ ...base, attachment: { type: "photo", fileId: "F" } })
      .text,
    "Напомню <b>29.10 в 10:00</b>: отдать\n📎 Вложение: фото",
  );
  assertEquals(
    buildConfirmCard({ ...base, attachment: { type: "document", fileId: "F" } })
      .text.endsWith("📎 Вложение: документ"),
    true,
  );
});

Deno.test("/list: у напоминания с вложением отметка 📎", () => {
  const msg = buildListMessage(
    [{
      id: "i1",
      text: "отдать",
      remind_at: "2026-10-29T07:00:00Z",
      attachment_type: "photo",
    }],
    TZ,
    NOW,
  );
  assertEquals(msg.text, "Твои напоминания:\n1. 29.10 в 10:00 — отдать 📎");
});

Deno.test("меню правки: кнопка «📎 Вложение» всегда; «🗑 Убрать вложение» только если оно есть", () => {
  const without = buildEditMenu(
    { id: "i1", text: "x", remind_at: "2026-10-29T07:00:00Z" },
    TZ,
    NOW,
  );
  const labels = (m: typeof without) =>
    m.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assertEquals(labels(without).includes("📎 Вложение"), true);
  assertEquals(labels(without).some((l) => l.includes("Убрать")), false);
  const withAtt = buildEditMenu(
    {
      id: "i1",
      text: "x",
      remind_at: "2026-10-29T07:00:00Z",
      attachment_type: "document",
    },
    TZ,
    NOW,
  );
  assertEquals(labels(withAtt).includes("🗑 Убрать вложение"), true);
  const data = withAtt.reply_markup.inline_keyboard.flat().map((b) =>
    b.callback_data
  );
  assertEquals(data.includes("eatt:i1"), true);
  assertEquals(data.includes("edel:i1"), true);
  assertEquals(decodeCallback("eatt:i1"), { action: "eatt", id: "i1" });
  assertEquals(decodeCallback("edel:i1"), { action: "edel", id: "i1" });
});

Deno.test("clipText: короткий текст не трогаем, длинный обрезаем с «…» до лимита", () => {
  assertEquals(clipText("привет", 10), "привет");
  assertEquals(clipText("а".repeat(20), 10), "ааааааааа…");
  assertEquals(clipText("а".repeat(20), 10).length, 10);
});

Deno.test("isMediaMessage: фото/документ — да, обычный текст — нет", () => {
  assertEquals(isMediaMessage({ photo: [{}] }), true);
  assertEquals(isMediaMessage({ document: {} }), true);
  assertEquals(isMediaMessage({ text: "привет" }), false);
  assertEquals(isMediaMessage(undefined), false);
});

Deno.test("captionFor: до 1024 символов — как есть (HTML), длиннее — обычный обрезанный текст без тегов", () => {
  assertEquals(captionFor("<b>ok</b>"), { text: "<b>ok</b>", html: true });
  const long = captionFor("<b>" + "а".repeat(2000) + "</b>");
  assertEquals(long.html, false);
  assertEquals(long.text.length <= 1024, true);
  assertEquals(long.text.includes("<"), false);
});
