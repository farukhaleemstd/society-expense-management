grant usage on schema public to authenticated;

grant select on all tables in schema public to authenticated;

grant update (read_at) on public.notifications to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;
