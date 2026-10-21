-- The runner provisioning a pool VM, so the reconciler can drop the row once that runner stops heart-beating.
alter table sandbox_vms add column provisioner_worker_id uuid;
