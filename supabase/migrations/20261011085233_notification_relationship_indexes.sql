-- Keep account/group cleanup and device revocation bounded as delivery history grows.
begin;
create index notification_outbox_subscription on private.notification_outbox(subscription_id);
create index notification_outbox_group on private.notification_outbox(group_id);
create index notification_outbox_actor on private.notification_outbox(actor_id);
commit;
