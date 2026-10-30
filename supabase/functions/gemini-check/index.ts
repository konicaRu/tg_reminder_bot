// ВРЕМЕННАЯ функция `gemini-check`: проверяет с сервера (из ЕС), доступен ли Gemini, какие
// модели есть и отвечает ли выбранная. Нужна, потому что из РФ Google блокирует запросы.
// Задеплоить → вызвать → удалить: `supabase functions delete gemini-check`.
// Защита — секрет TICK_SECRET в заголовке x-tick-secret. Ключ наружу не выводится.

import { isAuthorized } from "../tick/logic.ts";

const API = "https://generativelanguage.googleapis.com/v1beta";

Deno.serve(async (req) => {
  const secret = Deno.env.get("TICK_SECRET") ?? "";
  if (!isAuthorized(req.headers.get("x-tick-secret"), secret)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const key = Deno.env.get("GEMINI_API_KEY");
  if (!key) return Response.json({ error: "нет GEMINI_API_KEY" });

  const url = new URL(req.url);
  const model = url.searchParams.get("model");

  try {
    if (!model) {
      // список моделей, умеющих generateContent
      const r = await fetch(`${API}/models?pageSize=200`, {
        headers: { "x-goog-api-key": key },
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      if (!r.ok) {
        return Response.json({ http: r.status, error: data?.error?.message });
      }
      const names = (data.models ?? [])
        .filter((m: { supportedGenerationMethods?: string[] }) =>
          m.supportedGenerationMethods?.includes("generateContent")
        )
        .map((m: { name: string }) => m.name.replace("models/", ""));
      return Response.json({ http: r.status, models: names });
    }
    // пробный запрос к выбранной модели: просим короткий JSON
    const r = await fetch(
      `${API}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [{
              text: 'Верни JSON {"text":"ок","n":2} и ничего больше.',
            }],
          }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            maxOutputTokens: 200,
          },
        }),
        signal: AbortSignal.timeout(20000),
      },
    );
    const data = await r.json();
    return Response.json({
      http: r.status,
      error: data?.error?.message,
      answer: data?.candidates?.[0]?.content?.parts?.[0]?.text,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "ошибка" });
  }
});
