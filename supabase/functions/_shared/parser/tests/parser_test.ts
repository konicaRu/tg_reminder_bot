// Тесты парсера дат. Таблица «русская фраза → ожидаемый результат».
// Сначала описываем, как должно быть, потом пишем код.
//
// «Сейчас» зафиксировано: среда 28.10.2026, 12:00 по Москве (= 09:00 UTC),
// чтобы результат не зависел от настоящих часов. Москва = UTC+3, без перехода на летнее время.

// Встроенная в Deno проверка (node:assert): ничего не качает из интернета.
import { deepStrictEqual as assertEquals } from "node:assert";
import { type ParseFailReason, parseReminder } from "../mod.ts";

const NOW = new Date("2026-10-28T09:00:00Z");
const OPTS = { now: NOW, timezone: "Europe/Moscow", defaultTime: "09:00" };

// Успешный разбор: ожидаемый текст напоминания и момент срабатывания в UTC.
type OkCase = {
  input: string;
  text: string;
  at: string; // ISO в UTC
  adjusted?: "tomorrow"; // время сегодня уже прошло, перенесли на завтра
};
// Неуспешный разбор: причина отказа.
type FailCase = { input: string; fail: ParseFailReason };

const OK_CASES: OkCase[] = [
  // --- «через N …» ---
  {
    input: "через 3 минуты проверка",
    text: "проверка",
    at: "2026-10-28T09:03:00Z",
  },
  {
    input: "через 2 часа позвонить маме",
    text: "позвонить маме",
    at: "2026-10-28T11:00:00Z",
  },
  {
    input: "через час выпить воды",
    text: "выпить воды",
    at: "2026-10-28T10:00:00Z",
  },
  { input: "через полчаса чай", text: "чай", at: "2026-10-28T09:30:00Z" },
  {
    input: "через 15 минут размяться",
    text: "размяться",
    at: "2026-10-28T09:15:00Z",
  },
  {
    input: "через минуту выключить чайник",
    text: "выключить чайник",
    at: "2026-10-28T09:01:00Z",
  },
  {
    input: "через 2 дня оплатить счёт",
    text: "оплатить счёт",
    at: "2026-10-30T09:00:00Z",
  },
  {
    input: "через неделю записаться к врачу",
    text: "записаться к врачу",
    at: "2026-11-04T09:00:00Z",
  },
  {
    input: "через 2 недели отпуск",
    text: "отпуск",
    at: "2026-11-11T09:00:00Z",
  },

  // --- сегодня / завтра / послезавтра + время ---
  { input: "завтра в 11 встреча", text: "встреча", at: "2026-10-29T08:00:00Z" },
  {
    input: "завтра в 11:30 встреча с Ромой",
    text: "встреча с Ромой",
    at: "2026-10-29T08:30:00Z",
  },
  {
    input: "послезавтра в 8 позвонить маме",
    text: "позвонить маме",
    at: "2026-10-30T05:00:00Z",
  },
  {
    input: "сегодня в 18 забрать посылку",
    text: "забрать посылку",
    at: "2026-10-28T15:00:00Z",
  },
  // время сегодня уже прошло → переносим на завтра и помечаем
  {
    input: "сегодня в 9 зарядка",
    text: "зарядка",
    at: "2026-10-29T06:00:00Z",
    adjusted: "tomorrow",
  },
  {
    input: "в 9 утра зарядка",
    text: "зарядка",
    at: "2026-10-29T06:00:00Z",
    adjusted: "tomorrow",
  },

  // --- время без дня: ближайшее будущее («в 5» → 05:00 или 17:00) ---
  { input: "в 11 созвон", text: "созвон", at: "2026-10-28T20:00:00Z" }, // 11:00 уже прошло → 23:00
  { input: "в 11:30 созвон", text: "созвон", at: "2026-10-28T20:30:00Z" },
  { input: "в 5 купить хлеб", text: "купить хлеб", at: "2026-10-28T14:00:00Z" }, // 17:00
  { input: "в 14 совещание", text: "совещание", at: "2026-10-28T11:00:00Z" }, // 24-часовой формат — как есть
  { input: "в 12:30 обед", text: "обед", at: "2026-10-28T09:30:00Z" },
  {
    input: "в 23:30 лечь спать",
    text: "лечь спать",
    at: "2026-10-28T20:30:00Z",
  },

  // --- слова «утра / дня / вечера» уточняют время ---
  { input: "в 8 вечера ужин", text: "ужин", at: "2026-10-28T17:00:00Z" },
  {
    input: "завтра в 8 утра зарядка",
    text: "зарядка",
    at: "2026-10-29T05:00:00Z",
  },
  {
    input: "завтра в 3 дня встреча",
    text: "встреча",
    at: "2026-10-29T12:00:00Z",
  },
  {
    input: "сегодня в 11 вечера лечь спать",
    text: "лечь спать",
    at: "2026-10-28T20:00:00Z",
  },

  // --- время не указано → default_time (09:00 по Москве) ---
  { input: "завтра встреча", text: "встреча", at: "2026-10-29T06:00:00Z" },
  { input: "в пятницу отчёт", text: "отчёт", at: "2026-10-30T06:00:00Z" },

  // --- конкретные даты ---
  {
    input: "3 ноября в 15:00 встреча",
    text: "встреча",
    at: "2026-11-03T12:00:00Z",
  },
  {
    input: "29 октября в 10 стоматолог",
    text: "стоматолог",
    at: "2026-10-29T07:00:00Z",
  },
  {
    input: "28 октября в 20:00 кино",
    text: "кино",
    at: "2026-10-28T17:00:00Z",
  },
  {
    input: "3.11 день рождения",
    text: "день рождения",
    at: "2026-11-03T06:00:00Z",
  },
  {
    input: "15.12 в 18:30 корпоратив",
    text: "корпоратив",
    at: "2026-12-15T15:30:00Z",
  },
  // дата уже прошла в этом году → берём следующий год
  {
    input: "3 октября день рождения",
    text: "день рождения",
    at: "2027-10-03T06:00:00Z",
  },
  { input: "27 октября в 10 отчёт", text: "отчёт", at: "2027-10-27T07:00:00Z" },

  // --- дни недели (сегодня среда) ---
  {
    input: "в понедельник в 10 планёрка",
    text: "планёрка",
    at: "2026-11-02T07:00:00Z",
  },
  // «в среду» в среду = следующая среда, а не сегодня
  {
    input: "в среду в 15 встреча",
    text: "встреча",
    at: "2026-11-04T12:00:00Z",
  },
  {
    input: "в воскресенье в 12 обед",
    text: "обед",
    at: "2026-11-01T09:00:00Z",
  },

  // --- порядок слов, служебные слова, регистр, знаки препинания ---
  {
    input: "напомни завтра в 11 встреча",
    text: "встреча",
    at: "2026-10-29T08:00:00Z",
  },
  {
    input: "Напомни мне через 5 минут выключить плиту",
    text: "выключить плиту",
    at: "2026-10-28T09:05:00Z",
  },
  { input: "встреча завтра в 11", text: "встреча", at: "2026-10-29T08:00:00Z" },
  {
    input: "позвонить маме завтра в 10:15",
    text: "позвонить маме",
    at: "2026-10-29T07:15:00Z",
  },
  {
    input: "ЧЕРЕЗ 3 МИНУТЫ Проверка",
    text: "Проверка",
    at: "2026-10-28T09:03:00Z",
  },
  {
    input: "завтра, в 11: встреча",
    text: "встреча",
    at: "2026-10-29T08:00:00Z",
  },
];

const FAIL_CASES: FailCase[] = [
  // дата есть, а о чём напомнить — нет
  { input: "завтра в 9 утра", fail: "empty_text" },
  // даты нет вообще
  { input: "купить молоко", fail: "no_date" },
  // повторы, которые пока не умеем (только каждый день и дни недели), честно говорим «не поддерживается»
  { input: "каждые 2 недели в 9 отчёт", fail: "repeat_unsupported" },
  { input: "каждый месяц 15 числа оплата", fail: "repeat_unsupported" },
  { input: "каждый год 3 ноября поздравить", fail: "repeat_unsupported" },
  // повтор есть, а о чём напомнить — нет
  { input: "каждый день в 9", fail: "empty_text" },
];

// Повторы по расписанию: ожидаемые текст, строка RRULE и первое срабатывание.
type RepeatCase = { input: string; text: string; rrule: string; at: string };
const D9 = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
const WD = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
const REPEAT_CASES: RepeatCase[] = [
  {
    input: "каждый день в 9 зарядка",
    text: "зарядка",
    rrule: D9,
    at: "2026-10-29T06:00:00Z",
  },
  {
    input: "каждый понедельник в 10 планёрка",
    text: "планёрка",
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0",
    at: "2026-11-02T07:00:00Z",
  },
  {
    input: "каждый будний день в 9 зарядка",
    text: "зарядка",
    rrule: `${WD};BYHOUR=9;BYMINUTE=0`,
    at: "2026-10-29T06:00:00Z",
  },
  {
    input: "по будням в 8:30 стендап",
    text: "стендап",
    rrule: `${WD};BYHOUR=8;BYMINUTE=30`,
    at: "2026-10-29T05:30:00Z",
  },
  {
    input: "по выходным в 11 уборка",
    text: "уборка",
    rrule: "FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=11;BYMINUTE=0",
    at: "2026-10-31T08:00:00Z",
  },
  {
    input: "ежедневно в 22:00 выпить таблетку",
    text: "выпить таблетку",
    rrule: "FREQ=DAILY;BYHOUR=22;BYMINUTE=0",
    at: "2026-10-28T19:00:00Z",
  },
  {
    input: "каждую среду в 18:00 йога",
    text: "йога",
    rrule: "FREQ=WEEKLY;BYDAY=WE;BYHOUR=18;BYMINUTE=0",
    at: "2026-10-28T15:00:00Z",
  },
  {
    input: "каждый вторник и четверг в 19 тренировка",
    text: "тренировка",
    rrule: "FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=19;BYMINUTE=0",
    at: "2026-10-29T16:00:00Z",
  },
  {
    input: "по понедельникам и средам в 7 зарядка",
    text: "зарядка",
    rrule: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=7;BYMINUTE=0",
    at: "2026-11-02T04:00:00Z",
  },
  {
    input: "зарядка каждый день в 9",
    text: "зарядка",
    rrule: D9,
    at: "2026-10-29T06:00:00Z",
  },
  {
    input: "напомни каждый день зарядка",
    text: "зарядка",
    rrule: D9,
    at: "2026-10-29T06:00:00Z",
  },
  {
    input: "каждое воскресенье в 20:00 позвонить маме",
    text: "позвонить маме",
    rrule: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=20;BYMINUTE=0",
    at: "2026-11-01T17:00:00Z",
  },
  {
    input: "каждый день в 8 вечера принять лекарство",
    text: "принять лекарство",
    rrule: "FREQ=DAILY;BYHOUR=20;BYMINUTE=0",
    at: "2026-10-28T17:00:00Z",
  },
  {
    input: "каждое утро зарядка",
    text: "зарядка",
    rrule: D9,
    at: "2026-10-29T06:00:00Z",
  },
  {
    input: "каждый вечер гулять",
    text: "гулять",
    rrule: "FREQ=DAILY;BYHOUR=19;BYMINUTE=0",
    at: "2026-10-28T16:00:00Z",
  },
  {
    input: "каждую пятницу в 17:30 отчёт",
    text: "отчёт",
    rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=17;BYMINUTE=30",
    at: "2026-10-30T14:30:00Z",
  },
  {
    input: "в будние дни в 7 вставать",
    text: "вставать",
    rrule: `${WD};BYHOUR=7;BYMINUTE=0`,
    at: "2026-10-29T04:00:00Z",
  },
  {
    input: "каждые выходные в 10 рынок",
    text: "рынок",
    rrule: "FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=10;BYMINUTE=0",
    at: "2026-10-31T07:00:00Z",
  },
];

for (const c of REPEAT_CASES) {
  Deno.test(`повтор: «${c.input}»`, () => {
    const res = parseReminder(c.input, OPTS);
    if (!res.ok) {
      throw new Error(`ожидали успех, получили отказ: ${res.reason}`);
    }
    assertEquals(res.text, c.text);
    assertEquals(res.rrule, c.rrule);
    assertEquals(res.remindAt.toISOString(), new Date(c.at).toISOString());
    assertEquals(res.adjusted, undefined);
  });
}

for (const c of OK_CASES) {
  Deno.test(`разбор: «${c.input}»`, () => {
    const res = parseReminder(c.input, OPTS);
    if (!res.ok) {
      throw new Error(`ожидали успех, получили отказ: ${res.reason}`);
    }
    assertEquals(res.text, c.text);
    assertEquals(res.remindAt.toISOString(), new Date(c.at).toISOString());
    assertEquals(res.rrule, null); // в фазе 1 повторов нет
    assertEquals(res.adjusted, c.adjusted);
  });
}

// --- Отдельные проверки: другой «сейчас» и другой пояс ----------------------
Deno.test("поздно вечером «в 11» → оба варианта прошли, берём завтра 11:00 и помечаем", () => {
  // 23:50 по Москве: и 11:00, и 23:00 уже позади
  const late = { ...OPTS, now: new Date("2026-10-28T20:50:00Z") };
  const res = parseReminder("в 11 созвон", late);
  if (!res.ok) throw new Error(res.reason);
  assertEquals(res.remindAt.toISOString(), "2026-10-29T08:00:00.000Z");
  assertEquals(res.adjusted, "tomorrow");
});

Deno.test("другой пояс: Екатеринбург (UTC+5), «завтра в 11»", () => {
  const res = parseReminder("завтра в 11 встреча", {
    ...OPTS,
    timezone: "Asia/Yekaterinburg",
  });
  if (!res.ok) throw new Error(res.reason);
  assertEquals(res.remindAt.toISOString(), "2026-10-29T06:00:00.000Z"); // 11:00 − 5 ч
});

Deno.test("пояс с летним временем: Берлин до и после перехода 29.03.2026", () => {
  // 28.03 — ещё зимнее время (UTC+1), 30.03 — уже летнее (UTC+2)
  const opts = {
    ...OPTS,
    timezone: "Europe/Berlin",
    now: new Date("2026-03-20T09:00:00Z"),
  };
  const a = parseReminder("28.03 в 10 встреча", opts);
  const b = parseReminder("30.03 в 10 встреча", opts);
  if (!a.ok || !b.ok) throw new Error("ожидали успех");
  assertEquals(a.remindAt.toISOString(), "2026-03-28T09:00:00.000Z");
  assertEquals(b.remindAt.toISOString(), "2026-03-30T08:00:00.000Z");
});

for (const c of FAIL_CASES) {
  Deno.test(`отказ: «${c.input}» → ${c.fail}`, () => {
    const res = parseReminder(c.input, OPTS);
    if (res.ok) {
      throw new Error(`ожидали отказ ${c.fail}, получили успех: ${res.text}`);
    }
    assertEquals(res.reason, c.fail);
  });
}
