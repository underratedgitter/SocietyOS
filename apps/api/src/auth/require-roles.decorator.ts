import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'societyos:roles';
export const RequireRoles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
