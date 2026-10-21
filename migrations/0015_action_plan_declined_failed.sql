-- `rejected` meant "execution failed"; a user turning a plan down is now `declined`.
-- 0001 carries the same check twice (action_plans_status_check and _chk); keep one.
alter table action_plans drop constraint if exists action_plans_status_check;
alter table action_plans drop constraint if exists action_plans_status_chk;
update action_plans set status = 'failed' where status = 'rejected';
alter table action_plans add constraint action_plans_status_check
  check (status = any (array['proposed', 'approved', 'executing', 'declined', 'failed', 'executed', 'expired']));
