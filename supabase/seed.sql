-- Sandbox-only illustrative seed. Replace private references through controlled onboarding.
insert into public.partners(id,name) values('ptr_demo','Sandbox Partner') on conflict do nothing;
