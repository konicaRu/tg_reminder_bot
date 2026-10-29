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
  buildEditMenu,
  buildListMessage,
  buildStoppedMessage,
  decodeCallback,
  DEFAULT_NAG,
  describeNag,
  encodeCallback,
  escapeHtml,
  formatWhen,
  type InlineKeyboardMarkup,
  type Nag,
  NAG_COUNTS,
  NAG_INTERVALS,
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
    r: {
      chat_id: number;
      text: string;
      remind_at: Date;
      rrule: string | null;
      nag: Nag | null; // серия повторов или null (обычное напоминание)
    },
  ): Promise<Reminder>;
  listPendingReminders(chatId: number): Promise<Reminder[]>;
  cancelReminder(chatId: number, id: string): Promise<boolean>;
  // «Готово»: останавливает напоминание и серию; null, если останавливать нечего
  stopReminder(chatId: number, id: string): Promise<{ text: string } | null>;
  // Правка из /list: одно ожидающее напоминание (null, если уже сработало/удалено/чужое)
  getReminder(chatId: number, id: string): Promise<Reminder | null>;
  // false, если править уже нельзя (напоминание успело сработать или удалено)
  updateReminder(
    chatId: number,
    id: string,
    patch: { text?: string; remind_at?: Date },
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
  editGone: "Уже сработало или удалено",
  editTooLate: "Это напоминание уже сработало или удалено, изменить нельзя.",
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
  function cardFor(draft: Draft, opts: ParseOptions) {
    return buildConfirmCard({
      text: draft.text,
      remindAt: new Date(draft.remind_at),
      draftId: draft.id,
      timezone: opts.timezone,
      now: opts.now,
      adjusted: draft.adjusted ?? undefined,
      nag: draft.nag,
    });
  }

  // Сохраняем черновик в sessions и показываем карточку подтверждения.
  // nag переносим из предыдущего черновика, если пользователь просто сменил время.
  async function showCard(
    io: Io,
    res: Extract<ParseResult, { ok: true }>,
    opts: ParseOptions,
    nag: Nag | null = null,
  ): Promise<void> {
    const draft: Draft = {
      id: deps.newId(),
      text: res.text,
      remind_at: res.remindAt.toISOString(),
      adjusted: res.adjusted ?? null,
      nag,
    };
    await store.setSession(io.chatId, CONFIRM, draft);
    const card = cardFor(draft, opts);
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
    const patch: { text?: string; remind_at?: Date } = {};
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
      `${note}✅ Обновлено: ${when} — ${escapeHtml(patch.text ?? r.text)}`,
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
    async text(io: Io, input: string): Promise<void> {
      const opts = await parseOptions(io.chatId);
      const session = await store.getSession(io.chatId);
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
            ? `Новый текст для: «${
              escapeHtml(r.text)
            }»\nНапиши его одним сообщением.`
            : `Новое время для: «${escapeHtml(r.text)}»\n` +
              "Напиши, например, «завтра в 12» или «через час». " +
              "Можно сразу и новый текст: «завтра в 12 созвон».",
        );
        return io.answer();
      }

      // «Готово» под сообщением серии: останавливаем напоминание. id здесь — id самого
      // напоминания (а не черновика), поэтому обрабатываем до проверки черновика.
      if (c.action === "done") {
        const stopped = await store.stopReminder(io.chatId, c.id);
        if (!stopped) return io.answer("Уже остановлено");
        await io.edit(buildStoppedMessage(stopped.text)); // кнопки исчезают
        return io.answer("Повторы остановлены");
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
          rrule: null,
          nag,
        });
        await store.clearSession(io.chatId); // повторное нажатие уже не найдёт черновик → дубля нет
        const when = formatWhen(remindAt, settings.timezone, deps.now());
        await io.edit(
          `✅ Готово! Напомню <b>${when}</b>: ${escapeHtml(draft.text)}` +
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
        await io.edit(
          `Новый текст для: «${
            escapeHtml(draft.text)
          }»\nНапиши его одним сообщением.`,
        );
        return io.answer();
      }

      // c.action === "other"
      await store.setSession(io.chatId, AWAITING_TIME, {
        draftId: draft.id,
        text: draft.text,
        nag: draft.nag ?? null, // при смене времени настройки повтора не теряем
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
