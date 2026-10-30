import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** Server-side pagination (TZ 9.1): default 25, maksimal 100. Filtr DTO'lari shundan meros oladi. */
export class PaginationQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 25;
}

export const skipOf = (q: PaginationQuery) => (q.page - 1) * q.pageSize;

export function paginated<T>(items: T[], total: number, q: PaginationQuery) {
  return { items, total, page: q.page, pageSize: q.pageSize, pages: Math.ceil(total / q.pageSize) };
}
