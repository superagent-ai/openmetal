import { describe, expect, it } from "vitest";
import { paginateItems } from "./pagination";

describe("paginateItems", () => {
  const items = Array.from({ length: 45 }, (_, index) => index + 1);

  it("returns the first page", () => {
    const page = paginateItems(items, 1, 20);
    expect(page.rows).toEqual(items.slice(0, 20));
    expect(page).toMatchObject({
      total: 45,
      page: 1,
      pageCount: 3,
      pageSize: 20,
      from: 1,
      to: 20,
    });
  });

  it("returns a partial last page", () => {
    const page = paginateItems(items, 3, 20);
    expect(page.rows).toEqual([41, 42, 43, 44, 45]);
    expect(page.from).toBe(41);
    expect(page.to).toBe(45);
  });

  it("clamps a page past the end", () => {
    const page = paginateItems(items, 9, 20);
    expect(page.page).toBe(3);
    expect(page.rows).toHaveLength(5);
  });

  it("keeps an empty list on page 1", () => {
    const page = paginateItems([], 4, 20);
    expect(page).toMatchObject({
      rows: [],
      total: 0,
      page: 1,
      pageCount: 1,
      from: 0,
      to: 0,
    });
  });

  it("treats invalid page numbers as the first page", () => {
    expect(paginateItems(items, 0, 20).page).toBe(1);
    expect(paginateItems(items, -3, 20).page).toBe(1);
    expect(paginateItems(items, Number.NaN, 20).page).toBe(1);
  });
});
