export function paginateItems<T>(items: readonly T[], page: number, pageSize: number) {
  const size = Math.max(1, Math.floor(pageSize));
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const requested = Number.isFinite(page) ? Math.floor(page) : 1;
  const current = Math.min(Math.max(1, requested), pageCount);
  const start = (current - 1) * size;

  return {
    rows: items.slice(start, start + size),
    total,
    page: current,
    pageCount,
    pageSize: size,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + size, total),
  };
}
