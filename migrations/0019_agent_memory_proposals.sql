-- Memories drafted from comments by people without maintain/admin access wait for an admin.
alter table agent_memories drop constraint agent_memory_status_ck;
alter table agent_memories add constraint agent_memory_status_ck
    check (status = any (array['active', 'archived', 'proposed', 'rejected']));
alter table agent_memories add column proposed_by text;
-- {targetNativeId, commentNativeId?, actorLogin} of the comment; set on memories that needed approval.
alter table agent_memories add column source_comment_ref jsonb;
-- A proposal may share its title with the live entry it would replace on approval.
alter table agent_memories drop constraint agent_memory_title_uq;
create unique index agent_memory_title_uq on agent_memories (tenant_id, repository_id, title)
    where status in ('active', 'archived');
create unique index agent_memory_proposed_title_uq on agent_memories (tenant_id, repository_id, title)
    where status = 'proposed';
