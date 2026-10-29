// Повторы по расписанию: «каждый день в 9», «по будням», «каждый понедельник и четверг».
//
// Расписание хранится в одной строке по стандарту RRULE (RFC 5545), время срабатывания внутри:
//   FREQ=DAILY;BYHOUR=9;BYMINUTE=0
//   FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0
// Мы понимаем только это подмножество (каждый день / по дням недели в заданное время);
// всё остальное (INTERVAL, COUNT, MONTHLY…) считаем «не умеем» и возвращаем null.
// Благодаря BYHOUR/BYMINUTE snooze («+1 час») не сдвигает само расписание.
//
// Все функции «чистые» (без сети и часов), поэтому их легко тестировать.

import { addDays, localParts, weekdayOf, zonedToUtc } from "./parser/tz.ts";

export type RepeatRule = {
  days: number[]; // дни недели как в Date.getUTCDay(): 0 — воскресенье; пусто = каждый день
  hour: number;
  minute: number;
};

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]; // индекс = номер дня недели
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

// Строка RRULE → правило. Любое отклонение от нашего подмножества → null.
export function parseRrule(raw: string): RepeatRule | null {
  const parts = new Map<string, string>();
  for (const piece of raw.split(";")) {
    const [key, value, ...rest] = piece.split("=");
    if (!key || value === undefined || rest.length > 0) return null;
    if (parts.has(key)) return null;
    parts.set(key, value);
  }
  // Допустимые ключи: ничего лишнего (INTERVAL, COUNT, UNTIL… не поддерживаем).
  for (const key of parts.keys()) {
    if (!["FREQ", "BYDAY", "BYHOUR", "BYMINUTE"].includes(key)) return null;
  }

  const freq = parts.get("FREQ");
  const hourRaw = parts.get("BYHOUR");
  if ((freq !== "DAILY" && freq !== "WEEKLY") || hourRaw === undefined) {
    return null;
  }
  const hour = parseIntStrict(hourRaw);
  const minute = parseIntStrict(parts.get("BYMINUTE") ?? "0");
  if (hour === null || hour > 23 || minute === null || minute > 59) return null;

  const byday = parts.get("BYDAY");
  let days: number[] = [];
  if (byday !== undefined) {
    const idx = byday.split(",").map((c) => DAY_CODES.indexOf(c));
    if (idx.some((i) => i < 0)) return null;
    days = [...new Set(idx)].sort((a, b) => a - b);
  }
  // «Еженедельно» без дня недели не имеет смысла.
  if (freq === "WEEKLY" && days.length === 0) return null;
  return { days: normalizeDays(days), hour, minute };
}

function parseIntStrict(s: string): number | null {
  return /^\d{1,2}$/.test(s) ? Number(s) : null;
}

// Семь дней = «каждый день».
function normalizeDays(days: number[]): number[] {
  return days.length === 7 ? [] : days;
}

// Правило → строка RRULE. Дни идут в порядке недели (пн…вс), без повторов.
export function buildRrule(rule: RepeatRule): string {
  const order = [1, 2, 3, 4, 5, 6, 0]; // неделя начинается с понедельника
  const days = order.filter((d) => rule.days.includes(d));
  const time = `BYHOUR=${rule.hour};BYMINUTE=${rule.minute}`;
  return days.length === 0 || days.length === 7
    ? `FREQ=DAILY;${time}`
    : `FREQ=WEEKLY;BYDAY=${days.map((d) => DAY_CODES[d]).join(",")};${time}`;
}

// Ближайшее срабатывание СТРОГО после момента `after` (если `after` ровно момент срабатывания,
// вернётся следующее). Время «9:00» берётся по часам пояса tz, поэтому переход на летнее время
// не сдвигает его. Кривая строка → null.
export function nextOccurrence(
  rrule: string,
  after: Date,
  tz: string,
): Date | null {
  const rule = parseRrule(rrule);
  if (!rule) return null;
  const p = localParts(after, tz);
  const start = { y: p.y, m: p.m, d: p.d };
  // Неделя + запас на сегодняшний день и переходы часов: 8 дней вперёд всегда хватает.
  for (let i = 0; i <= 8; i++) {
    const day = addDays(start, i);
    if (rule.days.length > 0 && !rule.days.includes(weekdayOf(day))) continue;
    const at = zonedToUtc(day.y, day.m, day.d, rule.hour, rule.minute, tz);
    if (at.getTime() > after.getTime()) return at;
  }
  return null;
}

const DAY_NAMES_ACC = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среду",
  "четверг",
  "пятницу",
  "субботу",
];
const DAY_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

// Правило словами: «каждый день в 09:00», «по будням в 09:00», «каждую среду в 09:00».
export function describeRrule(rrule: string): string {
  const rule = parseRrule(rrule);
  if (!rule) return "по расписанию";
  const time = `${String(rule.hour).padStart(2, "0")}:${
    String(rule.minute).padStart(2, "0")
  }`;
  const same = (a: number[]) =>
    a.length === rule.days.length && a.every((d) => rule.days.includes(d));
  let when: string;
  if (rule.days.length === 0) when = "каждый день";
  else if (same(WEEKDAYS)) when = "по будням";
  else if (same(WEEKEND)) when = "по выходным";
  else if (rule.days.length === 1) {
    // «каждый понедельник», «каждую среду», «каждое воскресенье»
    const d = rule.days[0];
    const adj = d === 0
      ? "каждое"
      : [3, 5, 6].includes(d)
      ? "каждую"
      : "каждый";
    when = `${adj} ${DAY_NAMES_ACC[d]}`;
  } else {
    const order = [1, 2, 3, 4, 5, 6, 0];
    when = `по ${
      order.filter((d) => rule.days.includes(d)).map((d) => DAY_SHORT[d]).join(
        ", ",
      )
    }`;
  }
  return `${when} в ${time}`;
}
