-- «Настойчивое» напоминание: повторять через N минут, всего M раз, пока пользователь не нажмёт «Готово».
--
-- Это НЕ расписание вроде «каждый будний день» (его делает колонка rrule в фазе 2), а серия
-- повторных сообщений об ОДНОМ срабатывании: «⏰ Напоминание (2 из 10)».
--
-- Изменение аддитивное: добавляем три колонки, существующие строки не меняются
-- (у них nag_interval_min и nag_total пустые = обычное напоминание, как раньше).
--
-- Откат (если понадобится):
--   alter table public.reminders
--     drop column nag_interval_min, drop column nag_total, drop column nag_sent;

alter table public.reminders
  -- через сколько минут слать следующий повтор (пусто = обычное напоминание, без повторов)
  add column nag_interval_min int,
  -- сколько всего сообщений в серии, считая первое
  add column nag_total int,
  -- сколько сообщений серии уже отправлено
  add column nag_sent int not null default 0;

-- Защита на уровне базы: даже если из кода придёт ошибочное значение, спама не будет.
alter table public.reminders
  add constraint reminders_nag_consistent check (
    (nag_interval_min is null and nag_total is null)
    or (
      nag_interval_min between 1 and 1440 -- от минуты до суток
      and nag_total between 2 and 50 -- в серии минимум 2 сообщения, максимум 50
    )
  ),
  add constraint reminders_nag_sent_range check (nag_sent >= 0);
