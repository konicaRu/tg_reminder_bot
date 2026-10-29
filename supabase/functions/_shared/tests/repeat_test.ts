// Тесты повторов по расписанию: разбор строки RRULE, поиск ближайшего срабатывания и
// описание правила для человека. Сети и базы нет: функции «чистые».

import { deepStrictEqual as assertEquals } from "node:assert";
import {
  buildRrule,
  describeRrule,
  nextOccurrence,
  parseRrule,
} from "../repeat.ts";

const TZ = "Europe/Moscow"; // UTC+3 круглый год
const iso = (d: Date | null) => d?.toISOString() ?? null;

// --- Разбор и сборка строки -------------------------------------------------

Deno.test("parseRrule: каждый день, будни, дни недели; время внутри строки", () => {
  assertEquals(parseRrule("FREQ=DAILY;BYHOUR=9;BYMINUTE=0"), {
    days: [],
    hour: 9,
    minute: 0,
  });
  assertEquals(
    parseRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=30"),
    { days: [1, 2, 3, 4, 5], hour: 18, minute: 30 },
  );
  // порядок частей не важен, минуты по умолчанию 0
  assertEquals(parseRrule("BYHOUR=7;BYDAY=SU;FREQ=WEEKLY"), {
    days: [0],
    hour: 7,
    minute: 0,
  });
});

Deno.test("parseRrule: всё, что мы не умеем или что кривое → null", () => {
  for (
    const bad of [
      "",
      "мусор",
      "FREQ=MONTHLY;BYHOUR=9",
      "FREQ=YEARLY;BYHOUR=9",
      "FREQ=DAILY;INTERVAL=2;BYHOUR=9",
      "FREQ=DAILY;COUNT=3;BYHOUR=9",
      "FREQ=DAILY", // нет времени
      "FREQ=DAILY;BYHOUR=25",
      "FREQ=DAILY;BYHOUR=9;BYMINUTE=60",
      "FREQ=WEEKLY;BYHOUR=9", // еженедельно без дня
      "FREQ=WEEKLY;BYDAY=XX;BYHOUR=9",
      "FREQ=WEEKLY;BYDAY=1MO;BYHOUR=9",
    ]
  ) {
    assertEquals(parseRrule(bad), null, `для ${JSON.stringify(bad)}`);
  }
});

Deno.test("buildRrule и parseRrule обратимы; дни по порядку недели, без дублей", () => {
  const rule = { days: [4, 1, 1], hour: 9, minute: 5 };
  const s = buildRrule(rule);
  assertEquals(s, "FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=5");
  assertEquals(parseRrule(s), { days: [1, 4], hour: 9, minute: 5 });
  assertEquals(
    buildRrule({ days: [], hour: 9, minute: 0 }),
    "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  );
});

// --- Ближайшее срабатывание -------------------------------------------------
// «Сейчас» в тестах — среда 28.10.2026, 12:00 по Москве (09:00Z).

const WED_NOON = new Date("2026-10-28T09:00:00Z");

Deno.test("next: каждый день в 9 — после полудня это завтра", () => {
  assertEquals(
    iso(nextOccurrence("FREQ=DAILY;BYHOUR=9;BYMINUTE=0", WED_NOON, TZ)),
    "2026-10-29T06:00:00.000Z",
  );
});

Deno.test("next: время сегодня ещё впереди → сегодня; ровно в момент срабатывания → следующее (строго после)", () => {
  const rule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
  assertEquals(
    iso(nextOccurrence(rule, new Date("2026-10-28T05:00:00Z"), TZ)), // 08:00 МСК
    "2026-10-28T06:00:00.000Z",
  );
  assertEquals(
    iso(nextOccurrence(rule, new Date("2026-10-28T06:00:00Z"), TZ)),
    "2026-10-29T06:00:00.000Z",
  );
});

Deno.test("next: будни — после пятницы это понедельник", () => {
  const rule = "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0";
  assertEquals(
    iso(nextOccurrence(rule, new Date("2026-10-30T09:00:00Z"), TZ)), // пт 12:00
    "2026-11-02T06:00:00.000Z",
  );
  assertEquals(
    iso(nextOccurrence(rule, WED_NOON, TZ)), // ср 12:00 → чт
    "2026-10-29T06:00:00.000Z",
  );
});

Deno.test("next: выходные и отдельные дни недели", () => {
  assertEquals(
    iso(
      nextOccurrence(
        "FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=10;BYMINUTE=0",
        WED_NOON,
        TZ,
      ),
    ),
    "2026-10-31T07:00:00.000Z", // сб 10:00 МСК
  );
  const monThu = "FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=9;BYMINUTE=0";
  assertEquals(
    iso(nextOccurrence(monThu, WED_NOON, TZ)),
    "2026-10-29T06:00:00.000Z",
  );
  assertEquals(
    iso(nextOccurrence(monThu, new Date("2026-10-29T07:00:00Z"), TZ)), // чт 10:00 → пн
    "2026-11-02T06:00:00.000Z",
  );
});

Deno.test("next: переход через конец месяца и года", () => {
  assertEquals(
    iso(
      nextOccurrence(
        "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
        new Date("2026-12-31T09:00:00Z"),
        TZ,
      ),
    ),
    "2027-01-01T06:00:00.000Z",
  );
});

Deno.test("next: переход на летнее время (Берлин, 29.03.2026): 09:00 остаётся 09:00 по местному", () => {
  const rule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";
  assertEquals(
    iso(
      nextOccurrence(rule, new Date("2026-03-28T09:00:00Z"), "Europe/Berlin"),
    ),
    "2026-03-29T07:00:00.000Z", // 09:00 CEST = 07:00Z (раньше было 08:00Z)
  );
  assertEquals(
    iso(
      nextOccurrence(rule, new Date("2026-03-28T07:30:00Z"), "Europe/Berlin"),
    ),
    "2026-03-28T08:00:00.000Z", // 09:00 CET = 08:00Z
  );
});

Deno.test("next: кривое правило → null", () => {
  assertEquals(nextOccurrence("FREQ=MONTHLY;BYHOUR=9", WED_NOON, TZ), null);
});

// --- Описание для человека --------------------------------------------------

Deno.test("describeRrule: человеческое описание", () => {
  const d = (s: string) => describeRrule(s);
  assertEquals(d("FREQ=DAILY;BYHOUR=9;BYMINUTE=0"), "каждый день в 09:00");
  assertEquals(
    d("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0"),
    "по будням в 09:00",
  );
  assertEquals(
    d("FREQ=WEEKLY;BYDAY=SA,SU;BYHOUR=10;BYMINUTE=30"),
    "по выходным в 10:30",
  );
  assertEquals(
    d("FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0"),
    "каждый понедельник в 09:00",
  );
  assertEquals(
    d("FREQ=WEEKLY;BYDAY=WE;BYHOUR=9;BYMINUTE=0"),
    "каждую среду в 09:00",
  );
  assertEquals(
    d("FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=18;BYMINUTE=0"),
    "по вт, чт в 18:00",
  );
  assertEquals(d("мусор"), "по расписанию");
});
