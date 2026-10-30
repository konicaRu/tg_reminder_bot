// Тесты цепочки «основная модель → запасная».

import { deepStrictEqual as assertEquals } from "node:assert";
import { withFallback } from "../llm.ts";
import type { ParseOptions, ParseResult } from "../parser/mod.ts";

const OPTS: ParseOptions = {
  now: new Date("2026-10-28T09:00:00Z"),
  timezone: "Europe/Moscow",
  defaultTime: "09:00",
};
const OK: ParseResult = {
  ok: true,
  text: "x",
  remindAt: new Date("2026-10-30T05:00:00Z"),
  rrule: null,
  confidence: 0.9,
};
const FAIL = (reason: "llm_unavailable" | "llm_invalid" | "no_date") =>
  ({ ok: false, reason }) as ParseResult;

// «Модель»-двойник: возвращает заготовленный ответ (или бросает исключение) и считает вызовы.
function model(res: ParseResult | "throw") {
  let calls = 0;
  const fn = (_input: string, _opts: ParseOptions) => {
    calls++;
    return res === "throw"
      ? Promise.reject(new Error("boom"))
      : Promise.resolve(res);
  };
  return { fn, calls: () => calls };
}

Deno.test("цепочка: основная ответила → запасную не зовём", async () => {
  const a = model(OK);
  const b = model(OK);
  assertEquals(await withFallback(a.fn, b.fn)!("x", OPTS), OK);
  assertEquals(b.calls(), 0);
});

Deno.test("цепочка: основная ответила «не понял» (invalid) → это и есть ответ, запасную не зовём", async () => {
  const a = model(FAIL("llm_invalid"));
  const b = model(OK);
  assertEquals(
    await withFallback(a.fn, b.fn)!("x", OPTS),
    FAIL("llm_invalid"),
  );
  assertEquals(b.calls(), 0);
});

Deno.test("цепочка: основная недоступна → зовём запасную и берём её ответ", async () => {
  const a = model(FAIL("llm_unavailable"));
  const b = model(OK);
  assertEquals(await withFallback(a.fn, b.fn)!("x", OPTS), OK);
  assertEquals([a.calls(), b.calls()], [1, 1]);
});

Deno.test("цепочка: основная бросила исключение → считаем недоступной и зовём запасную", async () => {
  const a = model("throw");
  const b = model(OK);
  assertEquals(await withFallback(a.fn, b.fn)!("x", OPTS), OK);
});

Deno.test("цепочка: обе недоступны → llm_unavailable; запасная бросила → тоже llm_unavailable", async () => {
  assertEquals(
    await withFallback(
      model(FAIL("llm_unavailable")).fn,
      model(FAIL("llm_unavailable")).fn,
    )!("x", OPTS),
    FAIL("llm_unavailable"),
  );
  assertEquals(
    await withFallback(model(FAIL("llm_unavailable")).fn, model("throw").fn)!(
      "x",
      OPTS,
    ),
    FAIL("llm_unavailable"),
  );
});

Deno.test("цепочка: основной нет (не настроена) → работает запасная; обеих нет → undefined", async () => {
  const b = model(OK);
  const only = withFallback(undefined, b.fn);
  assertEquals(await only!("x", OPTS), OK);
  assertEquals(withFallback(undefined, undefined), undefined);
});

Deno.test("цепочка: о переключении сообщаем через onFallback (без текста фразы)", async () => {
  const events: string[] = [];
  const chain = withFallback(
    model(FAIL("llm_unavailable")).fn,
    model(OK).fn,
    () => events.push("switched"),
  );
  await chain!("секретная фраза", OPTS);
  assertEquals(events, ["switched"]);
});
