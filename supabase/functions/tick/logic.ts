// Логика функции `tick` — «будильника» бота.
//
// Раз в минуту её будит pg_cron (планировщик внутри базы). Задача tick: найти напоминания,
// время которых уже наступило, отправить их в Telegram и отметить как отправленные.
//
// Как и в bot, база и Telegram приходят снаружи (см. TickDeps): так всё проверяется тестами.

import type { Reminder } from "../_shared/db.ts";
import {
  buildDoneKeyboard,
  buildReminderMessage,
  type InlineKeyboardMarkup,
} from "../_shared/telegram.ts";

// Что tick нужно от базы (в проде это функции из _shared/db.ts).
export type TickStore = {
  claimDueReminders(): Promise<Reminder[]>; // атомарно забрать наступившие (pending → sending)
  // Отметить отправку. Без next → статус sent. С nextRemindAt → серия продолжается:
  // запись возвращается в pending на это время, nagSent — сколько сообщений серии ушло.
  // Возвращает false, если пользователь успел нажать «Готово» или 🗑 (запись уже не sending).
  markReminderSent(
    id: string,
    messageId: number,
    next: { nagSent?: number; nextRemindAt?: Date },
  ): Promise<boolean>;
  releaseReminder(id: string): Promise<void>; // вернуть в очередь (sending → pending)
};

export type TickDeps = {
  store: TickStore;
  // Отправить сообщение в Telegram (с кнопками или без), вернуть id отправленного сообщения.
  send: (
    chatId: number,
    text: string,
    markup?: InlineKeyboardMarkup,
  ) => Promise<number>;
  // Убрать кнопки у уже отправленного сообщения (необязательно: без него просто не убираем).
  clearKeyboard?: (chatId: number, messageId: number) => Promise<void>;
  now?: () => Date; // «сейчас» (в тестах фиксированное)
  log?: (message: string) => void;
};

export type TickSummary = { claimed: number; sent: number; failed: number };

export async function runTick(deps: TickDeps): Promise<TickSummary> {
  const log = deps.log ?? (() => {});

  // 1. Забираем наступившие. Это один атомарный запрос: если tick случайно запустили дважды,
  //    второй запуск не увидит этих записей и ничего не отправит повторно.
  //    Если база недоступна, ошибка уходит наружу: pg_cron просто повторит через минуту.
  const due = await deps.store.claimDueReminders();

  let sent = 0;
  let failed = 0;

  // 2. Отправляем по одному. Сбой одного напоминания не должен останавливать остальные.
  for (const r of due) {
    // «Настойчивое» напоминание: серия сообщений «(k из N)» с кнопкой «Готово».
    const interval = r.nag_interval_min;
    const total = r.nag_total;
    const isNag = interval != null && total != null;
    const index = (r.nag_sent ?? 0) + 1; // номер сообщения, которое отправляем сейчас

    let messageId: number;
    try {
      messageId = await deps.send(
        r.chat_id,
        buildReminderMessage(r.text, isNag ? { index, total } : undefined),
        isNag ? buildDoneKeyboard(r.id) : undefined,
      );
    } catch (err) {
      failed++;
      // В лог пишем id и причину, но НЕ текст напоминания: он может быть личным.
      log(`Не удалось отправить напоминание ${r.id}: ${errorMessage(err)}`);
      // Возвращаем в очередь: следующий запуск (через минуту) попробует снова.
      try {
        await deps.store.releaseReminder(r.id);
      } catch (err2) {
        log(
          `Не удалось вернуть напоминание ${r.id} в очередь: ${
            errorMessage(err2)
          }`,
        );
      }
      continue;
    }

    sent++;

    // У предыдущего сообщения серии убираем кнопку «Готово»: она остаётся только у самого
    // свежего. Делаем это ПОСЛЕ успешной отправки (если бы отправка упала, у человека
    // осталась бы рабочая кнопка) и не считаем сбой критичным: это только косметика.
    if (isNag && r.last_message_id && deps.clearKeyboard) {
      try {
        await deps.clearKeyboard(r.chat_id, r.last_message_id);
      } catch (err) {
        log(
          `Не удалось убрать кнопку у сообщения серии ${r.id}: ${
            errorMessage(err)
          }`,
        );
      }
    }

    // Что записать в базу. Для серии: счётчик и, если это не последнее сообщение, время
    // следующего. Считаем его от «сейчас», а не от старого срока: после сбоя tick не должен
    // присылать накопившиеся повторы пачкой.
    const next: { nagSent?: number; nextRemindAt?: Date } = {};
    if (isNag) {
      next.nagSent = index;
      if (index < total) {
        const now = (deps.now ?? (() => new Date()))();
        // Округляем вниз до начала минуты: tick срабатывает ровно в :00, а отправка идёт на
        // секунду позже. Без округления время повтора оказалось бы чуть ПОСЛЕ ближайшего
        // запуска, и 5 минут стабильно превращались бы в 6.
        const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
        next.nextRemindAt = new Date(minuteStart + interval * 60_000);
      }
    }

    // Сообщение УЖЕ ушло. Если отметить не вышло, повторяем один раз; возвращать в очередь
    // нельзя, иначе человек получит напоминание дважды. Ответ false означает, что пользователь
    // успел нажать «Готово»/🗑 — это штатно, его решение главнее, повтор не возобновляем.
    try {
      await deps.store.markReminderSent(r.id, messageId, next);
    } catch {
      try {
        await deps.store.markReminderSent(r.id, messageId, next);
      } catch (err) {
        log(`Отправили ${r.id}, но не смогли отметить: ${errorMessage(err)}`);
      }
    }
  }

  return { claimed: due.length, sent, failed };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Проверка секрета --------------------------------------------------------

// Сравнение «за постоянное время»: проходим по ВСЕМ байтам, даже если уже нашли различие.
// Обычное `a === b` останавливается на первой ошибке, и по скорости ответа можно угадывать
// секрет буква за буквой. Здесь время не зависит от того, где именно строки разошлись.
function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// Пустой секрет на сервере = ошибка настройки. Тогда не пускаем никого (а не всех).
export function isAuthorized(header: string | null, secret: string): boolean {
  if (!secret || header === null) return false;
  return constantTimeEqual(header, secret);
}

// --- HTTP-обёртка ------------------------------------------------------------

// Принимает запрос, проверяет секрет и метод, запускает tick, отвечает сводкой.
// Секрет приходит в заголовке x-tick-secret (его подставляет pg_cron).
export async function handleRequest(
  req: Request,
  o: { secret: string; run: () => Promise<TickSummary> },
): Promise<Response> {
  // Сначала секрет: незнакомцу не сообщаем даже о том, какие методы поддерживаются.
  if (!isAuthorized(req.headers.get("x-tick-secret"), o.secret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    return Response.json(await o.run());
  } catch (err) {
    // Подробности только в лог функции, наружу — общая фраза.
    console.error("tick: ошибка:", errorMessage(err));
    return new Response("Internal Error", { status: 500 });
  }
}
