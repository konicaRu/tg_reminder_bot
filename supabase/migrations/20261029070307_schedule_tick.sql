-- Расписание: раз в минуту будим функцию `tick`, которая отправляет наступившие напоминания.
--
-- Два расширения Postgres:
--   pg_cron — планировщик внутри базы (как cron в Linux): «запускай это по расписанию»;
--   pg_net  — HTTP-клиент внутри базы: умеет делать запросы по адресу.
-- Вместе: каждую минуту база сама делает POST на адрес функции tick.
--
-- ВАЖНО про секрет. TICK_SECRET нельзя писать в этот файл: он попадёт в git. Поэтому cron-команда
-- читает его из Supabase Vault (зашифрованное хранилище секретов внутри базы). Значение туда
-- кладётся ОДИН РАЗ вручную, в SQL Editor панели Supabase (в git его нет):
--
--   select vault.create_secret('<значение TICK_SECRET из .env>', 'tick_secret');
--
-- Пока секрета в Vault нет, tick отвечает 401 и ничего не отправляет: это безопасный отказ.
--
-- Отключить расписание:  select cron.unschedule('tick-every-minute');

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Если задание с таким именем уже есть, cron.schedule заменит его (миграцию можно применять повторно).
select cron.schedule(
  'tick-every-minute',
  '* * * * *', -- «каждую минуту»
  $$
  select net.http_post(
    url := 'https://jvicoaacpryfyubvtftp.supabase.co/functions/v1/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-tick-secret', coalesce(
        (select decrypted_secret from vault.decrypted_secrets where name = 'tick_secret'),
        ''
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
  $$
);
