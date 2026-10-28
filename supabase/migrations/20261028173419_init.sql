-- Начальная схема бота-напоминалки: три таблицы, индекс и автообновление updated_at.
-- Всё время хранится в UTC (timestamptz), пользователю показывается в его поясе.

-- Функция-триггер: при любом UPDATE сама ставит updated_at = now().
-- Так не нужно помнить про это в коде бота.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- reminders: сами напоминания
-- ---------------------------------------------------------------------------
create table public.reminders (
  id                 uuid primary key default gen_random_uuid(),
  chat_id            bigint      not null,
  text               text        not null,
  -- ближайшее срабатывание, UTC
  remind_at          timestamptz not null,
  -- правило повтора по RFC 5545; null = разовое напоминание
  rrule              text,
  -- pending -> sending (tick забрал) -> sent; done / cancelled ставит пользователь
  status             text        not null default 'pending'
                     check (status in ('pending', 'sending', 'sent', 'done', 'cancelled')),
  -- вложение (фаза 3): file_id у Telegram и его тип
  attachment_file_id text,
  attachment_type    text
                     check (attachment_type in ('photo', 'document', 'voice')),
  -- id сообщения с напоминанием (нужен для кнопок snooze, фаза 2)
  last_message_id    bigint,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Индекс под главный запрос tick: «найти pending, у которых remind_at уже наступил».
create index reminders_status_remind_at_idx on public.reminders (status, remind_at);

create trigger reminders_set_updated_at
  before update on public.reminders
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- settings: настройки пользователя
-- ---------------------------------------------------------------------------
create table public.settings (
  chat_id      bigint primary key,
  timezone     text not null default 'Europe/Moscow',
  -- время по умолчанию, когда в фразе нет часов
  default_time time not null default '09:00'
);

-- ---------------------------------------------------------------------------
-- sessions: состояние диалога
-- Функции ничего не помнят между запросами, поэтому «жду от пользователя новый
-- текст/время» хранится здесь.
-- ---------------------------------------------------------------------------
create table public.sessions (
  chat_id    bigint primary key,
  state      text  not null,
  payload    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create trigger sessions_set_updated_at
  before update on public.sessions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Безопасность: включаем RLS (построчную защиту) и не создаём ни одной политики.
-- Для публичных ключей Supabase доступа к таблицам нет вообще.
-- Функции bot и tick ходят в базу с service role, а он RLS обходит.
-- ---------------------------------------------------------------------------
alter table public.reminders enable row level security;
alter table public.settings  enable row level security;
alter table public.sessions  enable row level security;
