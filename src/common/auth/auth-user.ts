import type { PermissionCode } from '../permissions.js';

/** Access token tekshirilgach request.user ga yoziladigan foydalanuvchi. */
export interface AuthUser {
  id: string;
  storeId: string;
  sessionId: string;
  roleKey: string;
  name: string;
  permissions: Set<PermissionCode>;
}
