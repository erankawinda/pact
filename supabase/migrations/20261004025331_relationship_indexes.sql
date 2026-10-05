-- Cover relationship lookups and keep foreign-key checks efficient.
create index activity_actor on public.activity_log(actor_id);
create index shares_member on public.expense_shares(group_id,user_id);
create index expenses_creator on public.expenses(created_by);
create index expenses_payer on public.expenses(group_id,cash_actor_id);
create index groups_creator on public.groups(created_by);
create index groups_parent on public.groups(parent_household_id);
create index invitations_creator on public.invitations(created_by);
create index invitations_group_email on public.invitations(group_id,intended_email);
create index invitations_recipient on public.invitations(used_by);
create index operations_group on public.operation_requests(group_id);
