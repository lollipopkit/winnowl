export type Role = 'owner' | 'admin' | 'member' | 'viewer';

export type Permission =
  | 'review:read'
  | 'review:trigger'
  | 'config:read'
  | 'config:write'
  | 'learning:propose'
  | 'learning:approve'
  | 'learning:propose:org'
  | 'action:approve'
  | 'merge-gate:configure'
  | 'worker:kill'
  | 'installation:manage'
  | 'audit:read'
  | 'member:manage'
  | 'plan:read'
  | 'usage:read'
  | 'billing:manage';

const VIEWER: Permission[] = ['review:read', 'config:read', 'audit:read', 'plan:read'];
const MEMBER: Permission[] = [...VIEWER, 'review:trigger', 'learning:propose'];
const ADMIN: Permission[] = [
  ...MEMBER,
  'config:write',
  'learning:approve',
  'learning:propose:org',
  'action:approve',
  'merge-gate:configure',
  'worker:kill',
  'installation:manage',
  'member:manage',
  // Cost/usage is business data, hidden from viewer/member.
  'usage:read',
];
/** owner = admin + billing. */
const OWNER: Permission[] = [...ADMIN, 'billing:manage'];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: new Set(VIEWER),
  member: new Set(MEMBER),
  admin: new Set(ADMIN),
  owner: new Set(OWNER),
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export function isAdminRole(role: Role): boolean {
  return role === 'admin' || role === 'owner';
}
