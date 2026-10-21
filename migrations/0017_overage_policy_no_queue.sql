-- `queue` never queued anything: it skipped the review exactly like `reject`.
update subscriptions set overage_policy = 'reject' where overage_policy not in ('reject', 'degrade');
alter table subscriptions add constraint subscriptions_overage_policy_ck check (overage_policy in ('reject', 'degrade'));
