import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import { ALL_PERMISSIONS, PERMISSIONS, type PermissionCode } from '../common/permissions.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { CreateRoleDto, UpdateRoleDto } from './dto/roles.dto.js';

const roleInclude = {
  permissions: { select: { permissionCode: true } },
  _count: { select: { users: true } },
} as const;

type RoleRow = {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
  permissions: { permissionCode: string }[];
  _count: { users: number };
};

const present = (r: RoleRow) => ({
  id: r.id,
  key: r.key,
  name: r.name,
  isSystem: r.isSystem,
  permissions: r.permissions.map((p) => p.permissionCode).sort(),
  userCount: r._count.users,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthUser) {
    const rows = await this.prisma.role.findMany({
      where: { storeId: actor.storeId },
      include: roleInclude,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(present);
  }

  permissions() {
    return ALL_PERMISSIONS.map((code) => ({ code, description: PERMISSIONS[code] }));
  }

  private assertOwner(actor: AuthUser) {
    if (actor.roleKey !== 'owner') throw new ForbiddenException('Rollarni faqat owner boshqara oladi');
  }

  private validateCodes(codes: string[]): PermissionCode[] {
    const unique = [...new Set(codes)];
    const known = new Set<string>(ALL_PERMISSIONS);
    const bad = unique.filter((c) => !known.has(c));
    if (bad.length) throw new UnprocessableEntityException(`Noma’lum ruxsat kodlari: ${bad.join(', ')}`);
    return unique as PermissionCode[];
  }

  async create(actor: AuthUser, dto: CreateRoleDto, ctx: AuditContext) {
    this.assertOwner(actor);
    const codes = this.validateCodes(dto.permissions);
    const key = `custom-${randomBytes(4).toString('hex')}`;

    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          storeId: actor.storeId,
          key,
          name: dto.name.trim(),
          isSystem: false,
          permissions: { create: codes.map((permissionCode) => ({ permissionCode })) },
        },
        include: roleInclude,
      });
      await this.audit.log(
        ctx,
        { action: 'role.created', entityType: 'Role', entityId: role.id, metadata: { key, name: role.name, added: codes } },
        tx,
      );
      return present(role);
    });
  }

  async update(actor: AuthUser, id: string, dto: UpdateRoleDto, ctx: AuditContext) {
    this.assertOwner(actor);
    const codes = dto.permissions ? this.validateCodes(dto.permissions) : undefined;

    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findFirst({ where: { id, storeId: actor.storeId }, include: roleInclude });
      if (!role) throw new NotFoundException('Rol topilmadi');
      if (role.key === 'owner') throw new ForbiddenException('Owner roli o‘zgartirilmaydi');

      const metadata: Record<string, unknown> = { key: role.key };
      if (dto.name !== undefined && dto.name.trim() !== role.name) {
        await tx.role.update({ where: { id: role.id }, data: { name: dto.name.trim() } });
        metadata.name = { from: role.name, to: dto.name.trim() };
      }
      if (codes) {
        const current = new Set(role.permissions.map((p) => p.permissionCode));
        const next = new Set<string>(codes);
        const added = codes.filter((c) => !current.has(c));
        const removed = [...current].filter((c) => !next.has(c));
        if (removed.length) {
          await tx.rolePermission.deleteMany({ where: { roleId: role.id, permissionCode: { in: removed } } });
        }
        if (added.length) {
          await tx.rolePermission.createMany({ data: added.map((permissionCode) => ({ roleId: role.id, permissionCode })) });
        }
        metadata.added = added;
        metadata.removed = removed;
      }
      await this.audit.log(ctx, { action: 'role.updated', entityType: 'Role', entityId: role.id, metadata }, tx);

      const fresh = await tx.role.findFirstOrThrow({ where: { id: role.id }, include: roleInclude });
      return present(fresh);
    });
  }

  async remove(actor: AuthUser, id: string, ctx: AuditContext) {
    this.assertOwner(actor);
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findFirst({ where: { id, storeId: actor.storeId }, include: roleInclude });
      if (!role) throw new NotFoundException('Rol topilmadi');
      if (role.key === 'owner') throw new ForbiddenException('Owner roli o‘chirilmaydi');
      if (role.isSystem || !role.key.startsWith('custom-')) {
        throw new UnprocessableEntityException('Tizim rolini o‘chirib bo‘lmaydi');
      }
      if (role._count.users > 0) {
        throw new UnprocessableEntityException('Rolga xodimlar biriktirilgan, avval ularni boshqa rolga o‘tkazing');
      }
      await tx.role.delete({ where: { id: role.id } }); // RolePermission cascade
      await this.audit.log(
        ctx,
        {
          action: 'role.deleted',
          entityType: 'Role',
          entityId: role.id,
          metadata: { key: role.key, name: role.name, removed: role.permissions.map((p) => p.permissionCode) },
        },
        tx,
      );
      return { ok: true };
    });
  }
}
