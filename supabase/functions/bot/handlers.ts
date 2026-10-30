// «Мозг» бота: что делать, когда пользователь написал сообщение, нажал кнопку или вызвал /list.
//
// Здесь нет ни grammY, ни Supabase: всё внешнее (база, Telegram, парсер, часы) приходит
// снаружи через параметры. Это называется «внедрение зависимостей» (dependency injection):
// в проде мы подставляем настоящую базу и Telegram, а в тестах — «двойники» в памяти.
// Благодаря этому всю логику можно проверить тестами, не имея доступа к Telegram.
//
// Главная идея безопасности: НИЧЕГО не попадает в таблицу reminders, пока пользователь
// не нажмёт «✅ OK» на карточке подтверждения. До этого момента данные лежат в sessions
// как «черновик» (draft).

import type {
  ParseFailReason,
  ParseOptions,
  ParseResult,
} from "../_shared/parser/mod.ts";
import type { Reminder, Session, Settings } from "../_shared/db.ts";
import {
  type Attachment,
  buildConfirmCard,
  buildEditMenu,
  buildListMessage,
  buildSeriesStoppedMessage,
  buildSnoozedMessage,
  buildStoppedMessage,
  decodeCallback,
  DEFAULT_NAG,
  describeNag,
  encodeCallback,
  escapeHtml,
  formatWhen,
  heardLine,
  type InlineKeyboardMarkup,
  type Nag,
  NAG_COUNTS,
  NAG_INTERVALS,
  SNOOZE_OPTIONS,
  SNOOZE_TOMORROW,
} from "../_shared/telegram.ts";
import { addDays, localParts, zonedToUtc } from "../_shared/parser/tz.ts";
import { describeRrule, nextOccurrence } from "../_shared/repeat.ts";

// --- Что нужно «мозгу» снаружи -----------------------------------------------

// Хранилище: всё, что бот читает и пишет в базу. В проде это функции из _shared/db.ts.
export type Store = {
  getSettings(chatId: number): Promise<Settings>;
  getSession(chatId: number): Promise<Session | null>;
  setSession(
    chatId: number,
    state: string,
    payload: Record<string, unknown>,
  ): Promise<void>;
  clearSession(chatId: number): Promise<void>;
  createReminder(
    r: {
      chat_id: number;
      text: string;
      remind_at: Date;
      rrule: string | null;
      nag: Nag | null; // серия повторов или null (обычное напоминание)
      attachment?: Attachment | null; // приложенное фото/документ
    },
  ): Promise<Reminder>;
  listPendingReminders(chatId: number): Promise<Reminder[]>;
  cancelReminder(chatId: number, id: string): Promise<boolean>;
  // «Готово»: останавливает напоминание и серию; null, если останавливать нечего
  stopReminder(chatId: number, id: string): Promise<{ text: string } | null>;
  // «Готово»: у напоминания по расписанию переносит на следующее срабатывание (его считает
  // nextFor по строке rrule), у обычного закрывает. nextAt задан, если расписание продолжается.
  completeReminder(
    chatId: number,
    id: string,
    nextFor: (rrule: string) => Date | null,
  ): Promise<{ text: string; nextAt?: Date } | null>;
  // Snooze: перенести на новое время; null, если откладывать нечего (отменено, закрыто, чужое)
  snoozeReminder(
    chatId: number,
    id: string,
    remindAt: Date,
  ): Promise<{ text: string } | null>;
  // Правка из /list: одно ожидающее напоминание (null, если уже сработало/удалено/чужое)
  getReminder(chatId: number, id: string): Promise<Reminder | null>;
  // false, если править уже нельзя (напоминание успело сработать или удалено)
  updateReminder(
    chatId: number,
    id: string,
    patch: {
      text?: string;
      remind_at?: Date;
      rrule?: string;
      attachment?: Attachment | null;
    },
  ): Promise<boolean>;
};

// «Канал связи» с пользователем в рамках одного события (сообщения или нажатия кнопки).
export type Io = {
  chatId: number;
  // отправить новое сообщение
  reply(text: string, markup?: InlineKeyboardMarkup): Promise<void>;
  // изменить сообщение, под которым нажали кнопку (без markup кнопки исчезают)
  edit(text: string, markup?: InlineKeyboardMarkup): Promise<void>;
  // «всплывашка» над чатом; обязательно отвечаем на нажатие, иначе кнопка «крутится»
  answer(text?: string): Promise<void>;
};

// Результат распознавания голоса (его делает index.ts: скачать из Telegram → Whisper).
export type Transcription =
  | { ok: true; text: string }
  | { ok: false; reason: "stt_empty" | "unavailable" };

// Дольше этого голосовое не распознаём: бесплатные лимиты Groq общие, а напоминания короткие.
export const MAX_VOICE_SECONDS = 60;

export type Deps = {
  store: Store;
  parse: (input: string, opts: ParseOptions) => ParseResult; // правила
  llm?: (input: string, opts: ParseOptions) => Promise<ParseResult>; // Groq, может не быть
  // Распознать голосовое по file_id; нет функции = голос не настроен (нет ключа Groq)
  transcribe?: (fileId: string) => Promise<Transcription>;
  now: () => Date;
  newId: () => string; // короткий код черновика
};

// --- Безопасность ------------------------------------------------------------

// Whitelist («белый список»): бот отвечает только людям из списка (владелец и, например, семья).
export function isAllowed(
  userId: number | undefined,
  allowedIds: number[],
): boolean {
  return userId !== undefined && allowedIds.includes(userId);
}

// ALLOWED_USER_ID приходит из секретов строкой: один id или несколько через запятую
// («234320036,111222333»). Если там пусто или хоть один элемент кривой, бот не должен
// запускаться вообще, иначе «белый список» превратится в «пускаем всех».
export function parseAllowedIds(raw: string | undefined): number[] {
  const ids = (raw ?? "").split(",").map((part) => {
    const trimmed = part.trim();
    const n = Number(trimmed);
    if (!trimmed || !Number.isInteger(n) || n <= 0) {
      throw new Error(
        "ALLOWED_USER_ID: нужны положительные целые id через запятую",
      );
    }
    return n;
  });
  return [...new Set(ids)]; // дубли убираем
}

// «Завтра» для snooze: завтрашний день в поясе пользователя, время по умолчанию («09:00»).
function tomorrowAtDefaultTime(now: Date, s: Settings): Date {
  const today = localParts(now, s.timezone);
  const t = addDays({ y: today.y, m: today.m, d: today.d }, 1);
  const [h, mi] = s.default_time.split(":").map(Number);
  return zonedToUtc(t.y, t.m, t.d, h, mi, s.timezone);
}

// Подсказка при правке текста. Telegram не умеет подставить старый текст в поле ввода,
// поэтому показываем его в <code>: нажатие на такой текст копирует его целиком,
// остаётся вставить в поле и поправить.
function textPrompt(oldText: string): string {
  return `Текущий текст (нажми на него, чтобы скопировать):\n<code>${
    escapeHtml(oldText)
  }</code>\n\nВставь, поправь и отправь одним сообщением.`;
}

// --- Тексты бота (коротко, по-русски) ----------------------------------------

const MSG = {
  start: "Привет! Напиши, о чём и когда напомнить, например:\n" +
    "• «завтра в 11 встреча»\n" +
    "• «через 30 минут выключить плиту»\n" +
    "• «в пятницу в 18:00 позвонить маме»\n\n" +
    "/list — все напоминания.",
  noDate: "Не понял, когда напомнить 🤔\n" +
    "Попробуй так: «завтра в 11 встреча» или «через 2 часа позвонить маме».",
  emptyText: "О чём напомнить? Добавь текст, например: «завтра в 11 встреча».",
  repeat:
    "Такие повторы пока умею только: каждый день, по будням, по выходным " +
    "и по дням недели.\nНапример: «каждый будний день в 9 зарядка».",
  attachAsk:
    "📎 Получил. Когда и о чём напомнить? Например: «завтра в 10 отдать».",
  attachSendFile: "Пришли фото или файл (или нажми «К списку» в меню).",
  attachUpdated: "✅ Вложение обновлено.",
  attachRemoved: "🗑 Вложение убрано.",
  voiceOff: "Голос сейчас недоступен, напиши текстом.",
  voiceLong: "Голосовое длиннее минуты. Запиши покороче или напиши текстом.",
  voiceFail: "Не удалось разобрать голосовое, напиши текстом.",
  voiceEmpty: "Не расслышал. Повтори ещё раз или напиши текстом.",
  editGone: "Уже сработало или удалено",
  editTooLate: "Это напоминание уже сработало или удалено, изменить нельзя.",
  stale: "Эта карточка устарела. Напиши напоминание заново.",
  unsupported:
    "Пока понимаю только текст и голосовые. Напиши, например: «завтра в 11 встреча».",
} as const;

// Какое сообщение показать, если разобрать фразу не удалось.
function failureMessage(reason: ParseFailReason): string {
  if (reason === "empty_text") return MSG.emptyText;
  if (reason === "repeat_unsupported") return MSG.repeat;
  return MSG.noDate; // no_date, llm_unavailable, llm_invalid
}

// --- Состояния диалога (поле state в таблице sessions) ------------------------
const CONFIRM = "confirm"; // показали карточку, ждём «OK»
const AWAITING_TIME = "awaiting_time"; // нажали «Другое время», ждём новое время текстом
const ATTACH_WAIT = "attach_wait"; // прислали файл без подписи, ждём «когда и о чём»
const EDIT_ATTACH = "edit_attach"; // нажали «📎 Вложение» в меню правки, ждём файл
const DRAFT_TEXT = "draft_text"; // нажали «✏️ Текст» на карточке (до OK), ждём новый текст
const EDIT_TEXT = "edit_text"; // нажали «✏️ Текст» в меню правки, ждём новый текст
const EDIT_TIME = "edit_time"; // нажали «🕐 Время» в меню правки, ждём новое время

// Черновик напоминания: лежит в sessions.payload до нажатия «OK».
type Draft = {
  id: string; // код карточки: старая карточка не сможет подтвердить новый черновик
  text: string;
  remind_at: string; // ISO, UTC
  adjusted: "tomorrow" | null;
  nag: Nag | null; // «🔁 Повторять»: настройки серии повторов, null = выключено
  rrule?: string | null; // расписание («каждый будний день в 9»), null/нет = разовое
  attachment?: Attachment | null; // приложенное фото/документ
};

export function createHandlers(deps: Deps) {
  const { store } = deps;

  // Настройки пользователя → параметры для парсера (пояс, время по умолчанию, «сейчас»).
  async function parseOptions(chatId: number): Promise<ParseOptions> {
    const s = await store.getSettings(chatId);
    return {
      now: deps.now(),
      timezone: s.timezone,
      defaultTime: s.default_time,
    };
  }

  // Карточка по черновику (общая для первого показа и для обновления после нажатий).
  function cardFor(draft: Draft, opts: ParseOptions, heard?: string) {
    return buildConfirmCard({
      text: draft.text,
      remindAt: new Date(draft.remind_at),
      draftId: draft.id,
      timezone: opts.timezone,
      now: opts.now,
      adjusted: draft.adjusted ?? undefined,
      nag: draft.nag,
      rrule: draft.rrule,
      heard,
      attachment: draft.attachment,
    });
  }

  // Сохраняем черновик в sessions и показываем карточку подтверждения.
  // nag переносим из предыдущего черновика, если пользователь просто сменил время.
  async function showCard(
    io: Io,
    res: Extract<ParseResult, { ok: true }>,
    opts: ParseOptions,
    nag: Nag | null = null,
    heard?: string, // распознанный голос: показываем на новой карточке
    attachment: Attachment | null = null,
  ): Promise<void> {
    const draft: Draft = {
      id: deps.newId(),
      text: res.text,
      remind_at: res.remindAt.toISOString(),
      adjusted: res.adjusted ?? null,
      nag,
      rrule: res.rrule,
      attachment,
    };
    await store.setSession(io.chatId, CONFIRM, draft);
    const card = cardFor(draft, opts, heard);
    await io.reply(card.text, card.reply_markup);
  }

  // Ждём новое время после «🕐 Другое время».
  function onNewTime(
    io: Io,
    payload: Record<string, unknown>,
    input: string,
    opts: ParseOptions,
  ): Promise<void> {
    const oldText = String(payload.text ?? "");
    let res = deps.parse(input, opts);
    // Прислали только время («завтра в 12») → подставляем прежний текст напоминания.
    if (!res.ok && res.reason === "empty_text" && oldText) {
      res = deps.parse(`${input} ${oldText}`, opts);
    }
    // Не поняли → остаёмся в ожидании (состояние не меняем), пользователь может попробовать снова.
    if (!res.ok) return io.reply(failureMessage(res.reason));
    // Настройки повтора, выбранные до смены времени, сохраняем.
    return showCard(
      io,
      res,
      opts,
      (payload.nag as Nag | null | undefined) ?? null,
      undefined,
      (payload.attachment as Attachment | null | undefined) ?? null,
    );
  }

  // Список напоминаний (для /list, удаления и кнопки «К списку»).
  async function listFor(chatId: number) {
    const settings = await store.getSettings(chatId);
    const items = await store.listPendingReminders(chatId);
    return buildListMessage(items, settings.timezone, deps.now());
  }

  // Применяем правку, которую человек набрал после «✏️ Текст» / «🕐 Время».
  async function onEdit(
    io: Io,
    state: string,
    payload: Record<string, unknown>,
    input: string,
  ): Promise<void> {
    const id = String(payload.reminderId ?? "");
    const r = await store.getReminder(io.chatId, id);
    if (!r) { // успело сработать или удалено
      await store.clearSession(io.chatId);
      return io.reply(MSG.editTooLate);
    }
    const opts = await parseOptions(io.chatId);
    const patch: { text?: string; remind_at?: Date; rrule?: string } = {};
    let note = "";

    if (state === EDIT_TEXT) {
      const text = input.trim();
      // Пустой текст не принимаем, остаёмся в ожидании.
      if (!text) return io.reply("Текст не может быть пустым. Напиши ещё раз.");
      patch.text = text;
    } else {
      let res = deps.parse(input, opts);
      // Прислали только время («завтра в 12») → текст остаётся прежним.
      if (!res.ok && res.reason === "empty_text") {
        res = deps.parse(`${input} ${r.text}`, opts);
      }
      // Не поняли → остаёмся в ожидании, можно попробовать снова.
      if (!res.ok) return io.reply(failureMessage(res.reason));
      patch.remind_at = res.remindAt;
      // Новая фраза с «каждый…» заменяет расписание; обычное время двигает только ближайшее.
      if (res.rrule) patch.rrule = res.rrule;
      if (res.text !== r.text) patch.text = res.text; // время и текст одним сообщением
      if (res.adjusted === "tomorrow") {
        note = "Это время сегодня уже прошло, поставил на завтра.\n";
      }
    }

    const ok = await store.updateReminder(io.chatId, id, patch);
    await store.clearSession(io.chatId);
    if (!ok) return io.reply(MSG.editTooLate);

    const when = formatWhen(
      patch.remind_at ?? new Date(r.remind_at),
      opts.timezone,
      opts.now,
    );
    await io.reply(
      `${note}✅ Обновлено: ${when} — ${escapeHtml(patch.text ?? r.text)}` +
        (patch.rrule ? `\n📆 Повторяется ${describeRrule(patch.rrule)}` : ""),
      {
        inline_keyboard: [[{
          text: "📋 К списку",
          callback_data: encodeCallback({ action: "list", id: "all" }),
        }]],
      },
    );
  }

  return {
    // /start
    start(io: Io): Promise<void> {
      return io.reply(MSG.start);
    },

    // /list
    async list(io: Io): Promise<void> {
      const msg = await listFor(io.chatId);
      await io.reply(msg.text, msg.reply_markup);
    },

    // Обычное текстовое сообщение.
    // heard — этот текст на самом деле распознан из голосового (показываем «🎙 Я услышал»).
    async text(
      io: Io,
      input: string,
      heard?: string,
      captionAttachment?: Attachment,
    ): Promise<void> {
      const opts = await parseOptions(io.chatId);
      const session = await store.getSession(io.chatId);
      // Файл прислали раньше без подписи: этот текст становится его подписью.
      const attachment: Attachment | null = captionAttachment ??
        (session?.state === ATTACH_WAIT
          ? (session.payload.attachment as Attachment)
          : null);
      if (session?.state === DRAFT_TEXT) {
        const text = input.trim();
        if (!text) {
          return io.reply("Текст не может быть пустым. Напиши ещё раз.");
        }
        // Новый черновик с новым кодом: кнопки прежней карточки устаревают.
        const draft: Draft = {
          ...(session.payload as Draft),
          id: deps.newId(),
          text,
        };
        await store.setSession(io.chatId, CONFIRM, draft);
        const card = cardFor(draft, opts);
        return io.reply(card.text, card.reply_markup);
      }
      if (session?.state === EDIT_ATTACH) return io.reply(MSG.attachSendFile);
      if (session?.state === EDIT_TEXT || session?.state === EDIT_TIME) {
        return onEdit(io, session.state, session.payload, input);
      }
      if (session?.state === AWAITING_TIME) {
        return onNewTime(io, session.payload, input, opts);
      }

      // Сначала правила (быстро и бесплатно). К Groq идём, только если правила совсем не нашли дату.
      let res = deps.parse(input, opts);
      if (!res.ok && res.reason === "no_date" && deps.llm) {
        res = await deps.llm(input, opts);
      }
      if (!res.ok) {
        // Для голоса показываем, что именно услышал бот: так видно, ошибся ли Whisper.
        const prefix = heard !== undefined ? heardLine(heard) : "";
        return io.reply(prefix + failureMessage(res.reason));
      }
      if (session?.state === ATTACH_WAIT) await store.clearSession(io.chatId);
      return showCard(io, res, opts, null, heard, attachment);
    },

    // Фото или документ (подпись caption необязательна).
    async attachment(
      io: Io,
      a: { type: Attachment["type"]; fileId: string; caption?: string },
    ): Promise<void> {
      const file: Attachment = { type: a.type, fileId: a.fileId };
      const session = await store.getSession(io.chatId);

      // Правка: новый файл заменяет прежнее вложение напоминания.
      if (session?.state === EDIT_ATTACH) {
        const ok = await store.updateReminder(
          io.chatId,
          String(session.payload.reminderId ?? ""),
          { attachment: file },
        );
        await store.clearSession(io.chatId);
        if (!ok) return io.reply(MSG.editTooLate);
        return io.reply(MSG.attachUpdated, {
          inline_keyboard: [[{
            text: "📋 К списку",
            callback_data: encodeCallback({ action: "list", id: "all" }),
          }]],
        });
      }

      const caption = a.caption?.trim();
      if (caption) return this.text(io, caption, undefined, file);

      // Без подписи: запоминаем файл и спрашиваем, когда и о чём напомнить.
      await store.setSession(io.chatId, ATTACH_WAIT, { attachment: file });
      return io.reply(MSG.attachAsk);
    },

    // Голосовое сообщение: распознаём и дальше ведём как обычный текст.
    async voice(
      io: Io,
      v: { fileId: string; duration: number },
    ): Promise<void> {
      if (!deps.transcribe) return io.reply(MSG.voiceOff);
      if (v.duration > MAX_VOICE_SECONDS) return io.reply(MSG.voiceLong);
      let stt: Transcription;
      try {
        stt = await deps.transcribe(v.fileId);
      } catch {
        // Подробности не пишем: в них может быть адрес с токеном или личные данные.
        return io.reply(MSG.voiceFail);
      }
      if (!stt.ok) {
        return io.reply(
          stt.reason === "stt_empty" ? MSG.voiceEmpty : MSG.voiceFail,
        );
      }
      return this.text(io, stt.text, stt.text);
    },

    // Нажатие на inline-кнопку. data — то, что мы записали в callback_data.
    async callback(io: Io, data: string): Promise<void> {
      const c = decodeCallback(data);
      if (!c) return io.answer(); // не наш формат — молча игнорируем

      if (c.action === "del") {
        const removed = await store.cancelReminder(io.chatId, c.id);
        // Обновляем список прямо в том же сообщении, чтобы номера не «разъезжались».
        const msg = await listFor(io.chatId);
        await io.edit(msg.text, msg.reply_markup);
        return io.answer(removed ? "Удалено" : "Уже удалено");
      }

      // Правка из /list. Кнопки несут id самого напоминания (как del/done), поэтому
      // обрабатываем до проверки черновика. Принадлежность чату проверяет store.
      if (c.action === "list") {
        // Выходим из ожидания правки, если оно было (черновик карточки не трогаем).
        const s = await store.getSession(io.chatId);
        if (s?.state === EDIT_TEXT || s?.state === EDIT_TIME) {
          await store.clearSession(io.chatId);
        }
        const msg = await listFor(io.chatId);
        await io.edit(msg.text, msg.reply_markup);
        return io.answer();
      }
      if (c.action === "eatt" || c.action === "edel") {
        const r = await store.getReminder(io.chatId, c.id);
        if (!r) return io.answer(MSG.editGone);
        if (c.action === "eatt") {
          await store.setSession(io.chatId, EDIT_ATTACH, { reminderId: r.id });
          await io.edit(
            `Пришли фото или файл для: «${escapeHtml(r.text)}»\n` +
              "Он заменит текущее вложение.",
          );
          return io.answer();
        }
        const ok = await store.updateReminder(io.chatId, r.id, {
          attachment: null,
        });
        if (!ok) return io.answer(MSG.editGone);
        const settings = await store.getSettings(io.chatId);
        const fresh = await store.getReminder(io.chatId, r.id);
        const menu = buildEditMenu(
          fresh ?? { ...r, attachment_type: null },
          settings.timezone,
          deps.now(),
        );
        await io.edit(MSG.attachRemoved + "\n" + menu.text, menu.reply_markup);
        return io.answer();
      }
      if (c.action === "edit" || c.action === "etxt" || c.action === "etime") {
        const r = await store.getReminder(io.chatId, c.id);
        if (!r) return io.answer(MSG.editGone);
        const settings = await store.getSettings(io.chatId);
        if (c.action === "edit") {
          const menu = buildEditMenu(r, settings.timezone, deps.now());
          await io.edit(menu.text, menu.reply_markup);
          return io.answer();
        }
        const isText = c.action === "etxt";
        await store.setSession(io.chatId, isText ? EDIT_TEXT : EDIT_TIME, {
          reminderId: r.id,
        });
        await io.edit(
          isText
            ? textPrompt(r.text)
            : `Новое время для: «${escapeHtml(r.text)}»\n` +
              "Напиши, например, «завтра в 12» или «через час». " +
              "Можно сразу и новый текст: «завтра в 12 созвон».",
        );
        return io.answer();
      }

      // «Готово» под сообщением серии: останавливаем напоминание. id здесь — id самого
      // напоминания (а не черновика), поэтому обрабатываем до проверки черновика.
      // Snooze под сработавшим напоминанием: id тоже самого напоминания. Значение кнопки
      // приходит извне, поэтому принимаем только те, что мы рисовали.
      if (c.action === "snz") {
        if (c.arg === undefined || !SNOOZE_OPTIONS.includes(c.arg)) {
          return io.answer();
        }
        const settings = await store.getSettings(io.chatId);
        const now = deps.now();
        const at = c.arg === SNOOZE_TOMORROW
          ? tomorrowAtDefaultTime(now, settings)
          : new Date(now.getTime() + c.arg * 60_000);
        const snoozed = await store.snoozeReminder(io.chatId, c.id, at);
        if (!snoozed) return io.answer("Уже неактуально");
        const when = formatWhen(at, settings.timezone, now);
        await io.edit(buildSnoozedMessage(snoozed.text, when)); // кнопки исчезают
        return io.answer("Отложено");
      }

      if (c.action === "done") {
        const settings = await store.getSettings(io.chatId);
        const now = deps.now();
        const done = await store.completeReminder(
          io.chatId,
          c.id,
          (rrule) => nextOccurrence(rrule, now, settings.timezone),
        );
        if (!done) return io.answer("Уже остановлено");
        // У напоминания по расписанию закрыто только это срабатывание; показываем следующее.
        const next = done.nextAt
          ? `\n📆 Следующее: ${formatWhen(done.nextAt, settings.timezone, now)}`
          : "";
        await io.edit(buildStoppedMessage(done.text) + next); // кнопки исчезают
        return io.answer(done.nextAt ? "Готово" : "Повторы остановлены");
      }

      // «⛔ Прекратить повторы»: расписание закрывается совсем.
      if (c.action === "stop") {
        const stopped = await store.stopReminder(io.chatId, c.id);
        if (!stopped) return io.answer("Уже остановлено");
        await io.edit(buildSeriesStoppedMessage(stopped.text));
        return io.answer("Повторы прекращены");
      }

      // Остальные кнопки работают с черновиком; проверяем, что карточка не устарела.
      const session = await store.getSession(io.chatId);
      const draft = session?.state === CONFIRM
        ? (session.payload as Draft)
        : null;
      if (!draft || draft.id !== c.id) return io.answer(MSG.stale);

      if (c.action === "ok") {
        const settings = await store.getSettings(io.chatId);
        const remindAt = new Date(draft.remind_at);
        const nag = draft.nag ?? null;
        const created = await store.createReminder({
          chat_id: io.chatId,
          text: draft.text,
          remind_at: remindAt,
          rrule: draft.rrule ?? null,
          nag,
          attachment: draft.attachment ?? null,
        });
        await store.clearSession(io.chatId); // повторное нажатие уже не найдёт черновик → дубля нет
        const when = formatWhen(remindAt, settings.timezone, deps.now());
        await io.edit(
          `✅ Готово! Напомню <b>${when}</b>: ${escapeHtml(draft.text)}` +
            (draft.attachment
              ? `\n📎 Вложение: ${
                draft.attachment.type === "photo" ? "фото" : "документ"
              }`
              : "") +
            (draft.rrule
              ? `\n📆 Повторяется ${describeRrule(draft.rrule)}`
              : "") +
            (nag ? `\n🔁 Повторю ${describeNag(nag)}` : ""),
          // Кнопка «Изменить» остаётся: ошибку можно поправить и после «OK».
          {
            inline_keyboard: [[{
              text: "✏️ Изменить",
              callback_data: encodeCallback({ action: "edit", id: created.id }),
            }]],
          },
        );
        return io.answer();
      }

      // «🔁 Повторять / Выключить повтор», выбор интервала и количества: меняем черновик
      // и перерисовываем карточку на месте.
      if (c.action === "rep" || c.action === "ivl" || c.action === "cnt") {
        let nag = draft.nag ?? null;
        if (c.action === "rep") {
          nag = nag ? null : { ...DEFAULT_NAG };
        } else {
          // callback_data приходит извне: принимаем только значения, которые есть на кнопках,
          // и только когда повтор включён.
          const allowed = c.action === "ivl" ? NAG_INTERVALS : NAG_COUNTS;
          if (!nag || c.arg === undefined || !allowed.includes(c.arg)) {
            return io.answer();
          }
          nag = c.action === "ivl"
            ? { ...nag, intervalMin: c.arg }
            : { ...nag, total: c.arg };
        }
        const updated: Draft = { ...draft, nag };
        await store.setSession(io.chatId, CONFIRM, updated);
        const card = cardFor(updated, await parseOptions(io.chatId));
        await io.edit(card.text, card.reply_markup);
        return io.answer();
      }

      // «✏️ Текст» на карточке (до «OK»): ждём новый текст, время и повтор остаются.
      if (c.action === "dtxt") {
        await store.setSession(io.chatId, DRAFT_TEXT, draft);
        await io.edit(textPrompt(draft.text));
        return io.answer();
      }

      // c.action === "other"
      await store.setSession(io.chatId, AWAITING_TIME, {
        draftId: draft.id,
        text: draft.text,
        nag: draft.nag ?? null, // при смене времени настройки повтора не теряем
        attachment: draft.attachment ?? null,
      });
      await io.edit(
        `Меняем время для: «${escapeHtml(draft.text)}»\n` +
          "Напиши новое время, например «завтра в 12» или «через час».",
      );
      return io.answer();
    },

    // Фото, голос, файл и т.п.: в фазе 1 понимаем только текст.
    unsupported(io: Io): Promise<void> {
      return io.reply(MSG.unsupported);
    },
  };
}
