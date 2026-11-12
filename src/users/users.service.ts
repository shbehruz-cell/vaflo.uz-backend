import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';
import { AuditService, type AuditContext } from '../audit/audit.service.js';
import { normalizeLogin } from '../common/normalize.js';
import { passwordProblem } from '../common/password.js';
import type { PermissionCode } from '../common/permissions.js';
import { paginated, skipOf } from '../common/pagination.dto.js';
import type { AuthUser } from '../common/auth/auth-user.js';
import type { CreateUserDto, ListUsersQuery, ResetPasswordDto, UpdateUserDto } from './dto/users.dto.js';

/** passwordHash hech qachon qaytarilmaydi. */
const userSelect = {
  id: true,
  name: true,
  login: true,
  status: true,
  roleId: true,
  createdAt: true,
  updatedAt: true,
  role: { select: { id: true, key: true, name: true } },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(actor: AuthUser, q: ListUsersQuery) {
    const where: Prisma.UserWhereInput = { storeId: actor.storeId };
    if (q.status) where.status = q.status;
    const search = q.search?.trim();
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { login: { contains: search, mode: 'insensitive' } },
      ];
    }
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: userSelect,
        orderBy: { createdAt: 'desc' },
        skip: skipOf(q),
        take: q.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(items, total, q);
  }

  async get(actor: AuthUser, id: string) {
    const user = await this.prisma.user.findFirst({ where: { id, storeId: actor.storeId }, select: userSelect });
    if (!user) throw new NotFoundException('Xodim topilmadi');
    return user;
  }

  private async loadRole(db: PrismaService | Tx, storeId: string, roleId: string) {
    const role = await db.role.findFirst({ where: { id: roleId, storeId }, include: { permissions: { select: { permissionCode: true } } } });
    if (!role) throw new NotFoundException('Rol topilmadi');
    return role;
  }

  /**
   * Ruxsat ko‘tarilishiga (privilege escalation) qarshi: owner bo‘lmagan xodim faqat o‘zida bor
   * ruxsatlardan iborat rolni tayinlay oladi. Aks holda `users.manage` egasi o‘ziga/boshqaga
   * kengroq rol berib, amalda owner darajasiga chiqib ketishi mumkin edi.
   */
  private assertCanAssign(actor: AuthUser, role: { key: string; permissions: { permissionCode: string }[] }) {
    if (actor.roleKey === 'owner') return;
    if (role.key === 'owner') throw new ForbiddenException('Owner rolini faqat owner tayinlay oladi');
    const missing = role.permissions.map((p) => p.permissionCode as PermissionCode).filter((p) => !actor.permissions.has(p));
    if (missing.length) {
      throw new ForbiddenException(`Bu rolda sizda bo‘lmagan ruxsatlar bor (${missing.join(', ')}). Uni faqat owner tayinlay oladi`);
    }
  }

  async create(actor: AuthUser, dto: CreateUserDto, ctx: AuditContext) {
    const role = await this.loadRole(this.prisma, actor.storeId, dto.roleId);
    this.assertCanAssign(actor, role);
    const login = normalizeLogin(dto.login);
    const problem = passwordProblem(dto.password, login);
    if (problem) throw new UnprocessableEntityException(problem);
    if (await this.prisma.user.findUnique({ where: { login }, select: { id: true } })) {
      throw new ConflictException('Bu login band');
    }
    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: { storeId: actor.storeId, roleId: role.id, name: dto.name.trim(), login, passwordHash },
          select: userSelect,
        });
        await this.audit.log(
          ctx,
          { action: 'user.created', entityType: 'User', entityId: created.id, metadata: { login, role: role.key } },
          tx,
        );
        return created;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Bu login band');
      }
      throw e;
    }
  }

  async update(actor: AuthUser, id: string, dto: UpdateUserDto, ctx: AuditContext) {
    const isSelf = id === actor.id;
    if (isSelf && (dto.roleId !== undefined || dto.status !== undefined)) {
      throw new ForbiddenException('O‘z rolingiz yoki holatingizni o‘zgartira olmaysiz');
    }

    return this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findFirst({ where: { id, storeId: actor.storeId }, include: { role: true } });
      if (!target) throw new NotFoundException('Xodim topilmadi');
      if (target.role.key === 'owner' && actor.roleKey !== 'owner') {
        throw new ForbiddenException('Owner xodimni faqat owner tahrirlay oladi');
      }

      let newRole: { id: string; key: string } = target.role;
      if (dto.roleId !== undefined && dto.roleId !== target.roleId) {
        const loaded = await this.loadRole(tx, actor.storeId, dto.roleId);
        this.assertCanAssign(actor, loaded);
        newRole = loaded;
      }
      const newStatus = dto.status ?? target.status;

      // Kamida bitta faol owner qolishi shart.
      const losesOwner = target.role.key === 'owner' && target.status === 'ACTIVE' && (newRole.key !== 'owner' || newStatus !== 'ACTIVE');
      if (losesOwner) {
        const others = await tx.user.count({
          where: { storeId: actor.storeId, status: 'ACTIVE', role: { key: 'owner' }, id: { not: target.id } },
        });
        if (others === 0) throw new UnprocessableEntityException('Kamida bitta faol owner qolishi shart');
      }

      const data: Prisma.UserUpdateInput = {};
      if (dto.name !== undefined) data.name = dto.name.trim();
      if (newRole.id !== target.roleId) data.role = { connect: { id: newRole.id } };
      if (newStatus !== target.status) data.status = newStatus;

      const updated = await tx.user.update({ where: { id: target.id }, data, select: userSelect });

      const blocked = newStatus === 'BLOCKED' && target.status !== 'BLOCKED';
      const roleChanged = newRole.id !== target.roleId;
      if (blocked || roleChanged) {
        await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
      }

      const metadata: Record<string, unknown> = {};
      if (dto.name !== undefined && dto.name.trim() !== target.name) metadata.name = { from: target.name, to: dto.name.trim() };
      if (roleChanged) metadata.role = { from: target.role.key, to: newRole.key };
      if (newStatus !== target.status) metadata.status = { from: target.status, to: newStatus };
      const action = blocked ? 'user.blocked' : newStatus !== target.status ? 'user.unblocked' : roleChanged ? 'user.role_changed' : 'user.updated';
      await this.audit.log(ctx, { action, entityType: 'User', entityId: target.id, metadata }, tx);
      return updated;
    });
  }

  async resetPassword(actor: AuthUser, id: string, dto: ResetPasswordDto, ctx: AuditContext) {
    if (id === actor.id) {
      throw new UnprocessableEntityException('O‘z parolingizni “Parolni o‘zgartirish” orqali yangilang');
    }
    await this.prisma.$transaction(async (tx) => {
      const target = await tx.user.findFirst({ where: { id, storeId: actor.storeId }, include: { role: true } });
      if (!target) throw new NotFoundException('Xodim topilmadi');
      if (target.role.key === 'owner' && actor.roleKey !== 'owner') {
        throw new ForbiddenException('Owner xodimni faqat owner tahrirlay oladi');
      }
      const problem = passwordProblem(dto.newPassword, target.login);
      if (problem) throw new UnprocessableEntityException(problem);
      const passwordHash = await argon2.hash(dto.newPassword, { type: argon2.argon2id });
      await tx.user.update({ where: { id: target.id }, data: { passwordHash } });
      await tx.session.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log(ctx, { action: 'user.password_reset', entityType: 'User', entityId: target.id }, tx);
    });
    return { ok: true };
  }
}
