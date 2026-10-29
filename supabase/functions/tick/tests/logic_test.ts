// Тесты функции tick: «будильник», который раз в минуту отправляет наступившие напоминания.
// База и Telegram — «двойники» в памяти, настоящая сеть не нужна.

import { deepStrictEqual as assertEquals } from "node:assert";
import type { Reminder } from "../../_shared/db.ts";
import {
  handleRequest,
  isAuthorized,
  runTick,
  type TickStore,
} from "../logic.ts";

const SECRET = "tick-secret-123";

const rem = (id: string, chat: number, text: string): Reminder =>
  ({
    id,
    chat_id: chat,
    text,
    status: "sending",
    remind_at: "2026-10-29T08:00:00Z",
  }) as Reminder;

// Двойник: что «лежит в очереди» и что с ней сделали.
function setup(
  due: Reminder[],
  opts: { failSendFor?: string[]; claimThrows?: boolean } = {},
) {
  const sentMessages: { chatId: number; text: string }[] = [];
  const marked: { id: string; messageId: number }[] = [];
  const released: string[] = [];
  const logs: string[] = [];
  let claimCalls = 0;
  let messageCounter = 100;

  const store: TickStore = {
    claimDueReminders: () => {
      claimCalls++;
      if (opts.claimThrows) return Promise.reject(new Error("база недоступна"));
      return Promise.resolve(due);
    },
    markReminderSent: (id, messageId) => {
      marked.push({ id, messageId });
      return Promise.resolve();
    },
    releaseReminder: (id) => {
      released.push(id);
      return Promise.resolve();
    },
  };

  const send = (chatId: number, text: string) => {
    if (opts.failSendFor?.some((t) => text.includes(t))) {
      return Promise.reject(new Error("Telegram: 500"));
    }
    sentMessages.push({ chatId, text });
    return Promise.resolve(++messageCounter);
  };

  const deps = { store, send, log: (m: string) => logs.push(m) };
  return {
    deps,
    sentMessages,
    marked,
    released,
    logs,
    claimCalls: () => claimCalls,
  };
}

// --- Основной цикл -----------------------------------------------------------

Deno.test("tick: нечего отправлять → ничего не шлёт", async () => {
  const t = setup([]);
  const summary = await runTick(t.deps);
  assertEquals(summary, { claimed: 0, sent: 0, failed: 0 });
  assertEquals(t.sentMessages.length, 0);
});

Deno.test("tick: отправляет текст напоминания в нужный чат и отмечает «отправлено»", async () => {
  const t = setup([rem("r1", 555, "встреча")]);
  const summary = await runTick(t.deps);
  assertEquals(t.sentMessages, [{
    chatId: 555,
    text: "⏰ <b>Напоминание</b>\nвстреча",
  }]);
  assertEquals(t.marked, [{ id: "r1", messageId: 101 }]); // запомнили id сообщения
  assertEquals(summary, { claimed: 1, sent: 1, failed: 0 });
});

Deno.test("tick: текст пользователя экранируется (иначе Telegram отклонит сообщение)", async () => {
  const t = setup([rem("r1", 555, "a < b & c")]);
  await runTick(t.deps);
  assertEquals(
    t.sentMessages[0].text,
    "⏰ <b>Напоминание</b>\na &lt; b &amp; c",
  );
});

Deno.test("tick: несколько напоминаний уходят по порядку", async () => {
  const t = setup([
    rem("r1", 1, "первое"),
    rem("r2", 1, "второе"),
    rem("r3", 1, "третье"),
  ]);
  const summary = await runTick(t.deps);
  assertEquals(t.marked.map((m) => m.id), ["r1", "r2", "r3"]);
  assertEquals(summary, { claimed: 3, sent: 3, failed: 0 });
});

Deno.test("tick: если одно не отправилось — возвращаем в очередь, остальные всё равно уходят", async () => {
  const t = setup(
    [
      rem("r1", 1, "хорошее"),
      rem("r2", 1, "ПЛОХОЕ"),
      rem("r3", 1, "тоже хорошее"),
    ],
    { failSendFor: ["ПЛОХОЕ"] },
  );
  const summary = await runTick(t.deps);
  assertEquals(t.released, ["r2"]); // вернули в pending, следующий запуск попробует снова
  assertEquals(t.marked.map((m) => m.id), ["r1", "r3"]);
  assertEquals(summary, { claimed: 3, sent: 2, failed: 1 });
});

Deno.test("tick: ошибка пишется в лог без текста напоминания (там может быть личное)", async () => {
  const t = setup([rem("r2", 1, "секретное ПЛОХОЕ")], {
    failSendFor: ["ПЛОХОЕ"],
  });
  await runTick(t.deps);
  assertEquals(t.logs.length, 1);
  assertEquals(t.logs[0].includes("r2"), true);
  assertEquals(t.logs[0].includes("секретное"), false);
});

Deno.test("tick: если базу забрать не удалось — ошибка наружу (запуск будет повторен через минуту)", async () => {
  const t = setup([], { claimThrows: true });
  let threw = false;
  try {
    await runTick(t.deps);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

// --- Проверка секрета --------------------------------------------------------

Deno.test("секрет: верный — пускаем", () => {
  assertEquals(isAuthorized(SECRET, SECRET), true);
});

Deno.test("секрет: неверный, пустой, отсутствующий, другой длины — не пускаем", () => {
  assertEquals(isAuthorized("wrong", SECRET), false);
  assertEquals(isAuthorized("", SECRET), false);
  assertEquals(isAuthorized(null, SECRET), false);
  assertEquals(isAuthorized(SECRET + "x", SECRET), false);
  assertEquals(isAuthorized(SECRET.slice(0, -1), SECRET), false);
});

Deno.test("секрет: если секрет на сервере пустой — не пускаем никого (а не всех)", () => {
  assertEquals(isAuthorized("", ""), false);
  assertEquals(isAuthorized(null, ""), false);
});

// --- HTTP-обёртка ------------------------------------------------------------

const post = (headers: Record<string, string> = {}) =>
  new Request("http://x/", { method: "POST", headers });

Deno.test("HTTP: без секрета → 401, и в базу даже не заглядываем", async () => {
  const t = setup([rem("r1", 1, "встреча")]);
  const res = await handleRequest(post(), {
    secret: SECRET,
    run: () => runTick(t.deps),
  });
  assertEquals(res.status, 401);
  assertEquals(t.claimCalls(), 0);
  assertEquals(t.sentMessages.length, 0);
});

Deno.test("HTTP: неверный секрет → 401", async () => {
  const t = setup([rem("r1", 1, "встреча")]);
  const res = await handleRequest(post({ "x-tick-secret": "nope" }), {
    secret: SECRET,
    run: () => runTick(t.deps),
  });
  assertEquals(res.status, 401);
  assertEquals(t.claimCalls(), 0);
});

Deno.test("HTTP: GET вместо POST → 405", async () => {
  const t = setup([]);
  const res = await handleRequest(
    new Request("http://x/", {
      method: "GET",
      headers: { "x-tick-secret": SECRET },
    }),
    { secret: SECRET, run: () => runTick(t.deps) },
  );
  assertEquals(res.status, 405);
});

Deno.test("HTTP: верный секрет → 200 и сводка", async () => {
  const t = setup([rem("r1", 1, "встреча")]);
  const res = await handleRequest(post({ "x-tick-secret": SECRET }), {
    secret: SECRET,
    run: () => runTick(t.deps),
  });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { claimed: 1, sent: 1, failed: 0 });
});

Deno.test("HTTP: сбой внутри → 500 без подробностей наружу", async () => {
  const t = setup([], { claimThrows: true });
  const res = await handleRequest(post({ "x-tick-secret": SECRET }), {
    secret: SECRET,
    run: () => runTick(t.deps),
  });
  assertEquals(res.status, 500);
  const text = await res.text();
  assertEquals(text.includes("база недоступна"), false);
});
