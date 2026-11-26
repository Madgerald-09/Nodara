alter table public.events
  add column short_description text
    check (short_description is null or char_length(short_description) between 1 and 240),
  add column address text
    check (address is null or char_length(address) <= 300);
