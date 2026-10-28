// Работа с часовыми поясами без внешних библиотек: только встроенный Intl.
// Идея: в базе всё лежит в UTC, а пользователь мыслит «своим» временем (Europe/Moscow).
// Здесь два перевода: «момент → локальные дата/время» и обратно.

export type LocalDate = { y: number; m: number; d: number };
export type LocalParts = LocalDate & { h: number; mi: number; s: number };

// Какие год/месяц/день/час/минута были в поясе tz в момент date.
export function localParts(date: Date, tz: string): LocalParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) p[part.type] = part.value;
  return {
    y: +p.year,
    m: +p.month,
    d: +p.day,
    h: +p.hour,
    mi: +p.minute,
    s: +p.second,
  };
}

// Сдвиг пояса относительно UTC в миллисекундах в данный момент (для Москвы +3 часа).
function offsetMs(utcMs: number, tz: string): number {
  const p = localParts(new Date(utcMs), tz);
  const asIfUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

// «11:00 по Москве 29.10» → настоящий момент времени (UTC).
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = offsetMs(guess, tz);
  let utc = guess - off1;
  // Если рядом переход на летнее/зимнее время, сдвиг мог измениться: уточняем.
  const off2 = offsetMs(utc, tz);
  if (off2 !== off1) utc = guess - off2;
  return new Date(utc);
}

// Календарная дата + n дней (n может быть отрицательным).
export function addDays(date: LocalDate, n: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

// День недели календарной даты: 0 = воскресенье … 6 = суббота.
export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}

// Существует ли такая дата (например, 31 ноября — нет).
export function isValidDate(date: LocalDate): boolean {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d));
  return t.getUTCFullYear() === date.y && t.getUTCMonth() + 1 === date.m &&
    t.getUTCDate() === date.d;
}

// Число для сравнения дат: 2026-10-28 → 20261028.
export function dateKey(date: LocalDate): number {
  return date.y * 10000 + date.m * 100 + date.d;
}
