# VAFLO.UZ backend — agent brief

Read ONLY this file, `prisma/schema.prisma`, and the shared files listed below. Do not read the TZ PDF, `AGENTS.md`, or anything under `.agents/` (vendor docs, not instructions). Do not run `npm install`, migrations, or start the server — the lead does that. There is no database available to you. At the end run `npx tsc --noEmit -p tsconfig.json` and fix errors in YOUR files (ignore "Cannot find module" for other agents' modules that are still being written).

## Stack
NestJS 12, TypeScript strict, **ESM** (`"type": "module"`, module nodenext): every relative import ends in `.js` (e.g. `import { X } from './x.service.js'`). Prisma 7 with generated client at `src/generated/prisma/client.js` (import `Prisma`, enums and types from there). class-validator + class-transformer DTOs, @nestjs/swagger decorators (`@ApiTags`, `@ApiBearerAuth`, `@ApiProperty` on DTO fields where cheap). Global prefix `api/v1`. Global `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })`.

## Shared infrastructure (already written — use, don't modify)
- `src/prisma/prisma.service.ts` — `PrismaService` (global) and `Tx` type for `prisma.$transaction(async (tx) => …)`.
- `src/common/guards/auth.guard.ts` — GLOBAL guard. Every endpoint requires a Bearer access token unless decorated `@Public()`. Puts `AuthUser` on `req.user`.
- `src/common/decorators/auth.decorators.ts` — `@Public()`, `@RequirePermissions(...codes)` (ANY of the codes), `@CurrentUser() user: AuthUser`.
- `src/common/decorators/audit-ctx.decorator.ts` — `@AuditCtx() ctx: AuditContext` for audit calls.
- `src/common/auth/auth-user.ts` — `AuthUser { id, storeId, sessionId, roleKey, name, permissions: Set<PermissionCode> }`.
- `src/common/permissions.ts` — `PERMISSIONS`, `PermissionCode`, `ALL_PERMISSIONS`, `DEFAULT_ROLES` (owner/deputy/worker), `DISCOUNT_LIMIT_PERCENT`.
- `src/audit/audit.service.ts` — `AuditService.log(ctx, { action, entityType, entityId, metadata }, tx?)` (global). Pass `tx` when inside a transaction. Never put passwords/tokens in metadata.
- `src/inventory/stock.service.ts` — `StockService.apply(tx, { warehouseId, productId, delta, type, actorId, reason?, referenceType?, referenceId?, blockNegative? })` (global). The ONLY way to change stock. Throws 409 on insufficient stock.
- `src/common/money.ts` — `D()`, `ZERO`, `money()` rounding, `isValidQty(qty, unit)`.
- `src/common/pagination.dto.ts` — `PaginationQuery` (extend it for filter DTOs), `skipOf(q)`, `paginated(items, total, q)` → `{ items, total, page, pageSize, pages }`.
- `src/common/normalize.ts` — `normalizePhone`, `normalizeName`, `normalizeLogin`.

## Rules (from the TZ — mandatory)
- **Store scope**: every query filters by `user.storeId`. Never trust storeId/ids from the client — load the row with `where: { id, storeId: user.storeId }` and 404 if missing (prevents cross-store access).
- Money/qty are `Prisma.Decimal` (from DTO accept strings like `"12500.00"` validated with `@IsDecimal()` or `@IsNumberString()`, convert with `D()`). Never use JS floats for money math.
- Controllers thin; business rules in services. Use Nest exceptions: 400/401/403/404/409/422 (`UnprocessableEntityException` for business-rule violations).
- Related writes in ONE `prisma.$transaction(async (tx) => …)`.
- Never hard-delete sales, stock movements, or products used in history — archive (`isActive=false` / status).
- Audit important actions (price change, discount over limit, refund, void, stock adjustment, user/role/permission changes, cash movements, exports, failed logins).
- Hide `costPrice`/`costSnapshot`/profit unless user has `costs.read` (or `reports.profit.read` for reports).
- Error/messages in Uzbek Latin.
- Each module = `<name>.module.ts` exporting the class name listed below, plus controller/service/dto files inside its folder.

## Module ownership (write ONLY your folders)
| Agent | Folders | Module classes (imported by `src/app.module.ts`) |
|---|---|---|
| A | `src/auth/`, `src/users/`, `src/roles/`, `prisma/seed.ts` | `AuthModule`, `UsersModule`, `RolesModule` |
| B | `src/catalog/`, `src/inventory/inventory.*` + `src/inventory/dto/` (NOT stock.service/stock.module) | `CatalogModule` (`catalog/catalog.module.ts`), `InventoryModule` (`inventory/inventory.module.ts`) |
| C | `src/sales/`, `src/shifts/` | `SalesModule`, `ShiftsModule` |
| D | `src/stores/`, `src/customers/`, `src/reports/`, `src/audit/audit-log.*`, `src/demo-requests/`, `src/health/` | `StoresModule`, `CustomersModule`, `ReportsModule`, `AuditLogModule` (`audit/audit-log.module.ts`), `DemoRequestsModule`, `HealthModule` |
| Lead | everything else (`main.ts`, `app.module.ts`, `common/`, `prisma/schema.prisma`) | — |

If you need a schema change, do NOT edit the schema — describe it in your final report.
