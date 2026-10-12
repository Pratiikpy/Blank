-- Pin the trigger function's search_path (Supabase linter 0011).
alter function public.update_updated_at() set search_path = '';
