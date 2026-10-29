// Парсер дат на правилах: из русской фразы достаёт текст напоминания и момент срабатывания.
// Работает без сети и без часов системы (текущий момент передаётся параметром),
// поэтому его удобно тестировать.
//
// Как устроен: фраза «режется» на части. Каждое найденное правило (через N…, завтра,
// 3 ноября, в 11:30 …) вырезается из строки; то, что осталось, и есть текст напоминания.

import {
  addDays,
  dateKey,
  isValidDate,
  type LocalDate,
  localParts,
  weekdayOf,
  zonedToUtc,
} from "./tz.ts";
import { buildRrule, nextOccurrence } from "../repeat.ts";

export type ParseFailReason =
  | "no_date"
  | "empty_text"
  | "repeat_unsupported"
  | "llm_unavailable" // Groq не ответил (сеть, лимиты, ошибка сервера)
  | "llm_invalid"; // Groq ответил, но ответ не годится (не JSON, дата в прошлом…)

export type ParseOptions = {
  now: Date; // «текущий момент» (в тестах фиксированный)
  timezone: string; // пояс пользователя, например Europe/Moscow
  defaultTime: string; // «HH:MM» — время, если в фразе его нет
};

export type ParseResult =
  | {
    ok: true;
    text: string;
    remindAt: Date; // момент срабатывания (UTC)
    rrule: string | null; // строка RRULE для повторяющегося напоминания, иначе null
    confidence: number; // 0..1
    adjusted?: "tomorrow"; // время сегодня уже прошло — перенесли на завтра
  }
  | { ok: false; reason: ParseFailReason };

// --- Регулярные выражения ---------------------------------------------------
// В JS \b не понимает кириллицу, поэтому границы слова задаём через Unicode-классы.
const NB = "(?<![\\p{L}\\p{N}])"; // слева нет буквы/цифры
const NA = "(?![\\p{L}\\p{N}])"; // справа нет буквы/цифры

const MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];
// Индекс = getUTCDay(): 0 — воскресенье.
const WEEKDAY_STEMS = [
  "воскресень",
  "понедельник",
  "вторник",
  "сред",
  "четверг",
  "пятниц",
  "суббот",
];

const PERIOD = "утра|утром|дня|днём|днем|вечера|вечером|ночи|ночью";

const REPEAT_RE = new RegExp(
  `${NB}(?:кажд\\p{L}*|ежедневн\\p{L}*|еженедельн\\p{L}*|по\\s+(?:будням|выходным))${NA}`,
  "iu",
);

// --- Повторы по расписанию ---------------------------------------------------
const DAY_STEM = "понедельник|вторник|сред|четверг|пятниц|суббот|воскресень";
// «каждый день», «ежедневно»
const EVERY_DAY_RE = new RegExp(
  String.raw`${NB}(?:ежедневн\p{L}*|кажд\p{L}*\s+(?:день|дн\p{L}*))${NA}`,
  "iu",
);
// «каждое утро» / «каждый вечер»: каждый день, а время по умолчанию подсказывает слово
const EVERY_MORNING_RE = new RegExp(
  String.raw`${NB}каждое\s+утро${NA}`,
  "iu",
);
const EVERY_EVENING_RE = new RegExp(
  String.raw`${NB}кажд\p{L}*\s+вечер${NA}`,
  "iu",
);
// «по будням», «каждый будний день», «в будние дни»
const WEEKDAYS_RE = new RegExp(
  String
    .raw`${NB}(?:по|в|кажд\p{L}*)\s+будн\p{L}*(?:\s+(?:день|дн\p{L}*))?${NA}`,
  "iu",
);
// «по выходным», «каждые выходные», «в выходные дни»
const WEEKEND_RE = new RegExp(
  String
    .raw`${NB}(?:по|в|кажд\p{L}*)\s+выходн\p{L}*(?:\s+(?:день|дн\p{L}*))?${NA}`,
  "iu",
);
// «каждый понедельник», «по средам», «каждый вторник и четверг», «по пн…» не поддерживаем
const WEEKDAY_LIST_RE = new RegExp(
  String
    .raw`${NB}(?:по|кажд\p{L}*)\s+(?:${DAY_STEM})\p{L}*(?:\s*(?:,|и)\s*(?:${DAY_STEM})\p{L}*)*${NA}`,
  "iu",
);
const DAY_STEM_G = new RegExp(`${NB}(${DAY_STEM})`, "giu");

// Что нашли в фразе: дни недели ([] = каждый день), время по умолчанию из слова
// («вечер» → 19:00) и фраза без повтора.
type RepeatFound = {
  days: number[];
  defaultTime?: string;
  rest: string;
};

// Ищет в строке описание повтора. null — повтора в фразе нет; "unsupported" — слово
// «каждый…» есть, но такой повтор (раз в N недель, месяц, год…) мы пока не умеем.
function extractRepeat(s: string): RepeatFound | "unsupported" | null {
  const cut = (re: RegExp) => {
    const m = re.exec(s);
    return m
      ? { m, rest: s.slice(0, m.index) + " " + s.slice(m.index + m[0].length) }
      : null;
  };
  let r;
  if ((r = cut(WEEKDAYS_RE))) return { days: [1, 2, 3, 4, 5], rest: r.rest };
  if ((r = cut(WEEKEND_RE))) return { days: [0, 6], rest: r.rest };
  if ((r = cut(WEEKDAY_LIST_RE))) {
    const days = [...r.m[0].matchAll(DAY_STEM_G)].map((x) =>
      WEEKDAY_STEMS.findIndex((stem) => x[1].toLowerCase().startsWith(stem))
    );
    return { days, rest: r.rest };
  }
  if ((r = cut(EVERY_DAY_RE))) return { days: [], rest: r.rest };
  if ((r = cut(EVERY_MORNING_RE))) return { days: [], rest: r.rest };
  if ((r = cut(EVERY_EVENING_RE))) {
    return { days: [], defaultTime: "19:00", rest: r.rest };
  }
  return REPEAT_RE.test(s) ? "unsupported" : null;
}

// «напомни», «напомни мне» в начале фразы — служебные слова, в текст не идут.
const FILLER_RE =
  /^(?:напомни(?:те)?|напоминай(?:те)?)(?![\p{L}])(?:\s+мне(?![\p{L}]))?[\s,:-]*/iu;

const HALF_HOUR_RE = new RegExp(`${NB}через\\s+полчаса${NA}`, "iu");
const RELATIVE_RE = new RegExp(
  `${NB}через\\s+(?:(\\d+)\\s*)?(мин\\p{L}*|час\\p{L}*|ч${NA}|ден\\p{L}*|дн\\p{L}*|недел\\p{L}*)`,
  "iu",
);

const DAY_WORD_RE = new RegExp(`${NB}(послезавтра|завтра|сегодня)${NA}`, "iu");
const WEEKDAY_RE = new RegExp(
  `${NB}(?:в|во)\\s+(понедельник|вторник|сред[ауы]|четверг|пятниц[ауы]|суббот[ауы]|воскресень[еяю])${NA}`,
  "iu",
);
const MONTH_DATE_RE = new RegExp(
  `(?:${NB}(?:в|на)\\s+)?${NB}(\\d{1,2})\\s+(${MONTHS.join("|")})${NA}`,
  "iu",
);
// «3.11» или «3.11.2027»; не путать с временем «11.30» (время мы читаем только с «в» или «:»).
const DOT_DATE_RE =
  /(?<![\d.:])(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}))?(?![\d:]|\.\d)/u;

const TIME_COLON_RE = new RegExp(
  `(?:${NB}(?:в|к)\\s+)?(?<![\\d.:])(\\d{1,2}):(\\d{2})(?!\\d)(?:\\s*(${PERIOD})${NA})?`,
  "iu",
);
const TIME_HOUR_RE = new RegExp(
  `${NB}(?:в|к)\\s+(\\d{1,2})(?!\\d)(?![.:]\\d)(?:\\s*(${PERIOD})${NA})?`,
  "iu",
);

// --- Основная функция -------------------------------------------------------
export function parseReminder(input: string, opts: ParseOptions): ParseResult {
  const { now, timezone: tz } = opts;
  let s = input.replace(/\s+/g, " ").trim();

  s = s.replace(FILLER_RE, "");

  // Повторы по расписанию («каждый день в 9», «по будням», «каждый вторник и четверг»).
  const repeat = extractRepeat(s);
  if (repeat === "unsupported") {
    return { ok: false, reason: "repeat_unsupported" };
  }

  // Вырезает первое совпадение из строки s и возвращает его.
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(s);
    if (m) s = s.slice(0, m.index) + " " + s.slice(m.index + m[0].length);
    return m;
  };
  const cleanText = () =>
    s.replace(/\s+/g, " ").replace(/^[\s,.:;–—-]+|[\s,;:–—-]+$/gu, "").trim();

  const local = localParts(now, tz);
  const today: LocalDate = { y: local.y, m: local.m, d: local.d };

  if (repeat) {
    s = repeat.rest;
    // Время: «в 9», «в 18:30», «в 8 вечера»; иначе по умолчанию. Для повтора час берём
    // как написан (без угадывания «5 или 17»): карточка подтверждения покажет результат.
    let hour: number;
    let minute: number;
    const backup = s;
    const t = take(TIME_COLON_RE) ?? take(TIME_HOUR_RE);
    const hasMinutes = t !== null && t[2] !== undefined && /^\d/.test(t[2]);
    const h = t ? +t[1] : NaN;
    const mi = t ? (hasMinutes ? +t[2] : 0) : 0;
    if (t && h <= 23 && mi <= 59) {
      hour = h;
      minute = mi;
      const period = (hasMinutes ? t[3] : t[2])?.toLowerCase();
      if (period) {
        if (/^утр/.test(period)) {
          if (hour === 12) hour = 0;
        } else if (/^(дн|веч)/.test(period)) {
          if (hour < 12) hour += 12;
        } else if (/^ноч/.test(period)) {
          if (hour === 12) hour = 0;
          else if (hour >= 6 && hour < 12) hour += 12;
        }
      }
    } else {
      s = backup; // не похоже на время — оставляем в тексте
      const [dh, dmi] = (repeat.defaultTime ?? opts.defaultTime).split(":")
        .map(Number);
      hour = dh;
      minute = dmi;
    }
    const text = cleanText();
    if (!text) return { ok: false, reason: "empty_text" };
    const rrule = buildRrule({ days: repeat.days, hour, minute });
    const remindAt = nextOccurrence(rrule, now, tz);
    if (!remindAt) return { ok: false, reason: "repeat_unsupported" };
    return { ok: true, text, remindAt, rrule, confidence: 0.9 };
  }

  // 1. «через N минут/часов/дней/недель», «через полчаса»
  let relMinutes: number | null = null;
  let relDays: number | null = null;
  if (take(HALF_HOUR_RE)) {
    relMinutes = 30;
  } else {
    const m = take(RELATIVE_RE);
    if (m) {
      const n = m[1] ? Number(m[1]) : 1;
      const unit = m[2].toLowerCase();
      if (unit.startsWith("мин")) relMinutes = n;
      else if (unit.startsWith("час") || unit === "ч") relMinutes = n * 60;
      else if (unit.startsWith("нед")) relDays = n * 7;
      else relDays = n;
    }
  }

  // «Через N минут/часов» — точный отсчёт от «сейчас», остальное не нужно.
  if (relMinutes !== null) {
    const text = cleanText();
    if (!text) return { ok: false, reason: "empty_text" };
    const minuteStart = Math.floor(now.getTime() / 60000) * 60000;
    return {
      ok: true,
      text,
      remindAt: new Date(minuteStart + relMinutes * 60000),
      rrule: null,
      confidence: 1,
    };
  }

  // 2. День: «через N дней», дата, «сегодня/завтра/послезавтра», день недели
  let day: LocalDate | null = null;
  let rollYear = false; // дата без года: если уже прошла — берём следующий год
  if (relDays !== null) {
    day = addDays(today, relDays);
  } else {
    const md = MONTH_DATE_RE.exec(s);
    const dm = DOT_DATE_RE.exec(s);
    if (
      md &&
      isValidDate({
        y: today.y,
        m: MONTHS.indexOf(md[2].toLowerCase()) + 1,
        d: +md[1],
      })
    ) {
      take(MONTH_DATE_RE);
      day = {
        y: today.y,
        m: MONTHS.indexOf(md[2].toLowerCase()) + 1,
        d: +md[1],
      };
      rollYear = true;
    } else if (dm && +dm[2] >= 1 && +dm[2] <= 12) {
      const year = dm[3]
        ? (dm[3].length === 2 ? 2000 + +dm[3] : +dm[3])
        : today.y;
      const candidate = { y: year, m: +dm[2], d: +dm[1] };
      if (isValidDate(candidate)) {
        take(DOT_DATE_RE);
        day = candidate;
        rollYear = !dm[3];
      }
    }
    if (!day) {
      const w = take(DAY_WORD_RE);
      if (w) {
        const word = w[1].toLowerCase();
        day = addDays(
          today,
          word === "сегодня" ? 0 : word === "завтра" ? 1 : 2,
        );
      }
    }
    if (!day) {
      const w = take(WEEKDAY_RE);
      if (w) {
        const target = WEEKDAY_STEMS.findIndex((stem) =>
          w[1].toLowerCase().startsWith(stem)
        );
        // «в среду» в среду — это следующая среда, не сегодня
        const delta = (target - weekdayOf(today) + 7) % 7 || 7;
        day = addDays(today, delta);
      }
    }
  }

  // 3. Время: «в 11», «в 11:30», «15:00», «в 8 вечера»
  let hour: number | null = null;
  let minute = 0;
  let period: string | null = null;
  const backup = s;
  const t = take(TIME_COLON_RE) ?? take(TIME_HOUR_RE);
  if (t) {
    // Группы: у «11:30» это час, минуты, период; у «в 11» — час и период (минут нет).
    const hasMinutes = t[2] !== undefined && /^\d/.test(t[2]);
    const h = +t[1];
    const mi = hasMinutes ? +t[2] : 0;
    if (h > 23 || mi > 59) {
      s = backup; // не похоже на время (например, «в 99») — оставляем в тексте
    } else {
      hour = h;
      minute = mi;
      period = (hasMinutes ? t[3] : t[2])?.toLowerCase() ?? null;
    }
  }

  if (!day && hour === null) return { ok: false, reason: "no_date" };
  const text = cleanText();
  if (!text) return { ok: false, reason: "empty_text" };

  // «утра / дня / вечера / ночи» уточняют 12-часовое время
  let ambiguous = false;
  if (hour !== null) {
    if (period) {
      if (/^утр/.test(period)) {
        if (hour === 12) hour = 0;
      } else if (/^(дн|веч)/.test(period)) {
        if (hour < 12) hour += 12;
      } else if (/^ноч/.test(period)) {
        if (hour === 12) hour = 0;
        else if (hour >= 6 && hour < 12) hour += 12;
      }
    } else if (!day && hour >= 1 && hour <= 11) {
      // «в 5» без дня: это 05:00 или 17:00, берём ближайшее будущее
      ambiguous = true;
    }
  } else if (relDays !== null) {
    hour = local.h; // «через 2 дня» — то же время суток, что сейчас
    minute = local.mi;
  } else {
    const [dh, dmi] = opts.defaultTime.split(":").map(Number);
    hour = dh;
    minute = dmi;
  }
  const defaulted = t === null && relDays === null;

  // 4. Собираем момент срабатывания
  if (!day) {
    // Только время: ближайшее будущее сегодня, иначе завтра
    const hours = ambiguous ? [hour!, hour! + 12] : [hour!];
    for (const offset of [0, 1]) {
      const d = addDays(today, offset);
      for (const hh of hours) {
        const utc = zonedToUtc(d.y, d.m, d.d, hh, minute, tz);
        if (utc.getTime() > now.getTime()) {
          return {
            ok: true,
            text,
            remindAt: utc,
            rrule: null,
            confidence: ambiguous ? 0.7 : 0.9,
            ...(offset === 1 ? { adjusted: "tomorrow" as const } : {}),
          };
        }
      }
    }
  }

  let { y, m, d } = day!;
  if (rollYear && dateKey({ y, m, d }) < dateKey(today)) y += 1;
  let utc = zonedToUtc(y, m, d, hour!, minute, tz);
  let adjusted: "tomorrow" | undefined;
  // Сегодняшний день, но время уже прошло → предлагаем завтра
  if (
    dateKey({ y, m, d }) === dateKey(today) && utc.getTime() <= now.getTime()
  ) {
    const next = addDays({ y, m, d }, 1);
    utc = zonedToUtc(next.y, next.m, next.d, hour!, minute, tz);
    adjusted = "tomorrow";
  }
  return {
    ok: true,
    text,
    remindAt: utc,
    rrule: null,
    confidence: defaulted || adjusted ? 0.7 : 0.9,
    ...(adjusted ? { adjusted } : {}),
  };
}
