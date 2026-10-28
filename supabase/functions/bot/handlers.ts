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
  buildConfirmCard,
  buildListMessage,
  decodeCallback,
  escapeHtml,
  formatWhen,
  type InlineKeyboardMarkup,
} from "../_shared/telegram.ts";

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
    r: { chat_id: number; text: string; remind_at: Date; rrule: string | null },
  ): Promise<Reminder>;
  listPendingReminders(chatId: number): Promise<Reminder[]>;
  cancelReminder(chatId: number, id: string): Promise<boolean>;
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

export type Deps = {
  store: Store;
  parse: (input: string, opts: ParseOptions) => ParseResult; // правила
  llm?: (input: string, opts: ParseOptions) => Promise<ParseResult>; // Groq, может не быть
  now: () => Date;
  newId: () => string; // короткий код черновика
};

// --- Безопасность ------------------------------------------------------------

// Whitelist («белый список»): бот отвечает только владельцу.
export function isAllowed(
  userId: number | undefined,
  allowedId: number,
): boolean {
  return userId !== undefined && userId === allowedId;
}

// ALLOWED_USER_ID приходит из секретов строкой. Если он пустой или кривой, бот не должен
// запускаться вообще, иначе «белый список» превратится в «пускаем всех».
export function parseAllowedId(raw: string | undefined): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) {
    throw new Error("ALLOWED_USER_ID должен быть положительным целым числом");
  }
  return n;
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
  repeat: "Повторяющиеся напоминания пока не умею, это появится позже.\n" +
    "Могу поставить одно: например, «завтра в 9 зарядка».",
  stale: "Эта карточка устарела. Напиши напоминание заново.",
  unsupported:
    "Пока понимаю только текст. Напиши, например: «завтра в 11 встреча».",
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

// Черновик напоминания: лежит в sessions.payload до нажатия «OK».
type Draft = {
  id: string; // код карточки: старая карточка не сможет подтвердить новый черновик
  text: string;
  remind_at: string; // ISO, UTC
  adjusted: "tomorrow" | null;
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

  // Сохраняем черновик в sessions и показываем карточку подтверждения.
  async function showCard(
    io: Io,
    res: Extract<ParseResult, { ok: true }>,
    opts: ParseOptions,
  ): Promise<void> {
    const draft: Draft = {
      id: deps.newId(),
      text: res.text,
      remind_at: res.remindAt.toISOString(),
      adjusted: res.adjusted ?? null,
    };
    await store.setSession(io.chatId, CONFIRM, draft);
    const card = buildConfirmCard({
      text: draft.text,
      remindAt: res.remindAt,
      draftId: draft.id,
      timezone: opts.timezone,
      now: opts.now,
      adjusted: res.adjusted,
    });
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
    return showCard(io, res, opts);
  }

  return {
    // /start
    start(io: Io): Promise<void> {
      return io.reply(MSG.start);
    },

    // /list
    async list(io: Io): Promise<void> {
      const settings = await store.getSettings(io.chatId);
      const items = await store.listPendingReminders(io.chatId);
      const msg = buildListMessage(items, settings.timezone, deps.now());
      await io.reply(msg.text, msg.reply_markup);
    },

    // Обычное текстовое сообщение.
    async text(io: Io, input: string): Promise<void> {
      const opts = await parseOptions(io.chatId);
      const session = await store.getSession(io.chatId);
      if (session?.state === AWAITING_TIME) {
        return onNewTime(io, session.payload, input, opts);
      }

      // Сначала правила (быстро и бесплатно). К Groq идём, только если правила совсем не нашли дату.
      let res = deps.parse(input, opts);
      if (!res.ok && res.reason === "no_date" && deps.llm) {
        res = await deps.llm(input, opts);
      }
      if (!res.ok) return io.reply(failureMessage(res.reason));
      return showCard(io, res, opts);
    },

    // Нажатие на inline-кнопку. data — то, что мы записали в callback_data.
    async callback(io: Io, data: string): Promise<void> {
      const c = decodeCallback(data);
      if (!c) return io.answer(); // не наш формат — молча игнорируем

      if (c.action === "del") {
        const removed = await store.cancelReminder(io.chatId, c.id);
        // Обновляем список прямо в том же сообщении, чтобы номера не «разъезжались».
        const settings = await store.getSettings(io.chatId);
        const items = await store.listPendingReminders(io.chatId);
        const msg = buildListMessage(items, settings.timezone, deps.now());
        await io.edit(msg.text, msg.reply_markup);
        return io.answer(removed ? "Удалено" : "Уже удалено");
      }

      // «OK» и «Другое время» работают с черновиком; проверяем, что карточка не устарела.
      const session = await store.getSession(io.chatId);
      const draft = session?.state === CONFIRM
        ? (session.payload as Draft)
        : null;
      if (!draft || draft.id !== c.id) return io.answer(MSG.stale);

      if (c.action === "ok") {
        const settings = await store.getSettings(io.chatId);
        const remindAt = new Date(draft.remind_at);
        await store.createReminder({
          chat_id: io.chatId,
          text: draft.text,
          remind_at: remindAt,
          rrule: null,
        });
        await store.clearSession(io.chatId); // повторное нажатие уже не найдёт черновик → дубля нет
        const when = formatWhen(remindAt, settings.timezone, deps.now());
        await io.edit(
          `✅ Готово! Напомню <b>${when}</b>: ${escapeHtml(draft.text)}`,
        );
        return io.answer();
      }

      // c.action === "other"
      await store.setSession(io.chatId, AWAITING_TIME, {
        draftId: draft.id,
        text: draft.text,
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
