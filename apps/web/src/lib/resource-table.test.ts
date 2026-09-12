import { describe, expect, it } from "vitest";
import {
  applyResourceTableState,
  deleteResourceSearchQualifierAtCaret,
  getResourceSearchSuggestionMode,
  parseResourceSearchQuery,
  PENDING_PROVIDER_FILTER,
  providerLabel,
  tokenizeResourceSearchQuery,
  toggleSearchQualifier,
  type ResourceTableRow,
} from "./resource-table";

function row(
  overrides: Partial<ResourceTableRow> & Pick<ResourceTableRow, "id">,
): ResourceTableRow {
  return {
    type: "sandbox",
    provider: "daytona",
    state: "ready",
    created_at: "2026-08-01T00:00:00.000Z",
    ready_at: "2026-08-01T00:01:00.000Z",
    paused_at: null,
    stopped_at: null,
    cost_microusd: "1000000",
    ...overrides,
  };
}

const now = Date.parse("2026-08-01T02:00:00.000Z");

const rows = [
  row({
    id: "e2b-ready",
    provider: "e2b",
    state: "ready",
    created_at: "2026-08-01T00:03:00.000Z",
    ready_at: "2026-08-01T00:10:00.000Z",
    cost_microusd: "3000000",
  }),
  row({
    id: "modal-pending",
    provider: "modal",
    state: "paused",
    created_at: "2026-08-01T00:02:00.000Z",
    ready_at: "2026-08-01T00:05:00.000Z",
    paused_at: "2026-08-01T00:20:00.000Z",
    cost_microusd: "5000000",
  }),
  row({
    id: "daytona-failed",
    provider: "daytona",
    state: "failed",
    created_at: "2026-08-01T00:01:00.000Z",
    ready_at: null,
    cost_microusd: null,
  }),
  row({
    id: "pending-provider",
    provider: null,
    state: "requested",
    created_at: "2026-08-01T00:04:00.000Z",
    ready_at: null,
    cost_microusd: null,
  }),
  row({
    id: "vercel-ready",
    provider: "vercel",
    state: "ready",
    created_at: "2026-08-01T00:00:00.000Z",
    ready_at: "2026-08-01T01:00:00.000Z",
    cost_microusd: "2000000",
  }),
];

function ids(result: { rows: ResourceTableRow[] }) {
  return result.rows.map((item) => item.id);
}

function table(query = "", extra?: Partial<Parameters<typeof applyResourceTableState>[1]>) {
  return applyResourceTableState(rows, {
    query,
    sort: null,
    page: 1,
    now,
    ...extra,
  });
}

describe("parseResourceSearchQuery", () => {
  it("parses github style qualifiers with optional spaces", () => {
    expect(parseResourceSearchQuery("provider: e2b status:ready")).toEqual({
      providers: ["e2b"],
      statuses: ["ready"],
      types: [],
      terms: [],
    });
  });

  it("normalizes labels and quoted values", () => {
    expect(parseResourceSearchQuery('provider:"Code Sandbox" status:"cleanup pending"')).toEqual({
      providers: ["codesandbox"],
      statuses: ["cleanup_pending"],
      types: [],
      terms: [],
    });
  });

  it("keeps unmatched words as text terms", () => {
    expect(parseResourceSearchQuery("provider:vercel sbx_123")).toEqual({
      providers: ["vercel"],
      statuses: [],
      types: [],
      terms: ["sbx_123"],
    });
  });

  it("ignores incomplete qualifiers while typing", () => {
    expect(parseResourceSearchQuery("provider:")).toEqual({
      providers: [],
      statuses: [],
      types: [],
      terms: [],
    });
    expect(parseResourceSearchQuery("provider: ")).toEqual({
      providers: [],
      statuses: [],
      types: [],
      terms: [],
    });
  });
});

describe("tokenizeResourceSearchQuery", () => {
  it("tracks badge ranges for github style provider tokens", () => {
    const tokens = tokenizeResourceSearchQuery("provider: e2b sbx_123");
    expect(tokens).toEqual([
      {
        start: 0,
        end: 13,
        raw: "provider: e2b",
        key: "provider",
        value: "e2b",
      },
      {
        start: 14,
        end: 21,
        raw: "sbx_123",
        key: null,
        value: "sbx_123",
      },
    ]);
  });
});

describe("getResourceSearchSuggestionMode", () => {
  it("suggests qualifiers on an empty query", () => {
    expect(getResourceSearchSuggestionMode("", 0)).toEqual({
      kind: "qualifiers",
      prefix: "",
      replaceStart: 0,
      replaceEnd: 0,
    });
  });

  it("suggests provider values after a provider qualifier", () => {
    expect(getResourceSearchSuggestionMode("provider: ", 10)).toEqual({
      kind: "values",
      qualifier: "provider",
      prefix: "",
      replaceStart: 0,
      replaceEnd: 10,
    });
  });

  it("filters qualifier keys from a typed prefix", () => {
    expect(getResourceSearchSuggestionMode("prov", 4)).toEqual({
      kind: "qualifiers",
      prefix: "prov",
      replaceStart: 0,
      replaceEnd: 4,
    });
  });
});

describe("deleteResourceSearchQualifierAtCaret", () => {
  it("removes an empty provider badge in one backspace", () => {
    expect(deleteResourceSearchQualifierAtCaret("provider:", 9)).toEqual({
      query: "",
      caret: 0,
    });
    expect(deleteResourceSearchQualifierAtCaret("provider: ", 10)).toEqual({
      query: "",
      caret: 0,
    });
  });

  it("removes a completed qualifier after its trailing space", () => {
    expect(deleteResourceSearchQualifierAtCaret("provider: e2b ", 14)).toEqual({
      query: "",
      caret: 0,
    });
  });

  it("removes the badge when the caret is inside the qualifier key", () => {
    expect(deleteResourceSearchQualifierAtCaret("provider: e2b", 4)).toEqual({
      query: "",
      caret: 0,
    });
  });

  it("keeps character deletion inside the qualifier value", () => {
    expect(deleteResourceSearchQualifierAtCaret("provider: e2b", 13)).toBeNull();
  });

  it("removes only the preceding qualifier among other terms", () => {
    expect(deleteResourceSearchQualifierAtCaret("sbx_123 provider: e2b ", 22)).toEqual({
      query: "sbx_123 ",
      caret: 8,
    });
  });
});

describe("toggleSearchQualifier", () => {
  it("adds and removes qualifier tokens", () => {
    const added = toggleSearchQualifier("sbx_123", "provider", "e2b");
    expect(added).toBe("provider: e2b sbx_123");
    expect(toggleSearchQualifier(added, "provider", "e2b")).toBe("sbx_123");
  });
});

describe("applyResourceTableState", () => {
  it("keeps original order when sort is unset", () => {
    expect(ids(table())).toEqual([
      "e2b-ready",
      "modal-pending",
      "daytona-failed",
      "pending-provider",
      "vercel-ready",
    ]);
  });

  it("filters by provider and status together", () => {
    const result = table("provider:e2b provider:vercel status:ready");
    expect(ids(result)).toEqual(["e2b-ready", "vercel-ready"]);
    expect(result.total).toBe(2);
  });

  it("narrows providers by prefix while a value is being typed", () => {
    expect(ids(table("provider: e"))).toEqual(["e2b-ready"]);
  });

  it("treats an empty query as all values", () => {
    expect(ids(table("status:paused"))).toEqual(["modal-pending"]);
  });

  it("does not filter on an incomplete provider qualifier", () => {
    expect(ids(table("provider:"))).toHaveLength(5);
    expect(ids(table("provider: "))).toHaveLength(5);
  });

  it("filters pending providers with the pending sentinel", () => {
    expect(ids(table(`provider:${PENDING_PROVIDER_FILTER}`))).toEqual(["pending-provider"]);
  });

  it("filters free text against provider and id", () => {
    expect(ids(table("E2B"))).toEqual(["e2b-ready"]);
    expect(ids(table("e2b-ready"))).toEqual(["e2b-ready"]);
  });

  it("filters by type qualifier", () => {
    expect(ids(table("type:sandbox"))).toHaveLength(5);
    expect(ids(table("type:gpu"))).toEqual([]);
  });

  it("builds facet counts from the unfiltered rows", () => {
    const result = table("provider:e2b status:ready");
    expect(result.providerFacets.get("e2b")).toBe(1);
    expect(result.providerFacets.get("modal")).toBe(1);
    expect(result.providerFacets.get(PENDING_PROVIDER_FILTER)).toBe(1);
    expect(result.statusFacets.get("ready")).toBe(2);
    expect(result.statusFacets.get("failed")).toBe(1);
  });

  it("sorts provider by display label", () => {
    const result = table("", { sort: { column: "provider", direction: "asc" } });
    expect(ids(result)).toEqual([
      "daytona-failed",
      "e2b-ready",
      "modal-pending",
      "pending-provider",
      "vercel-ready",
    ]);
    expect(providerLabel(null)).toBe("Pending");
  });

  it("sorts status alphabetically", () => {
    const result = table("", { sort: { column: "status", direction: "asc" } });
    expect(ids(result)).toEqual([
      "daytona-failed",
      "modal-pending",
      "e2b-ready",
      "vercel-ready",
      "pending-provider",
    ]);
  });

  it("sorts created by datetime", () => {
    const result = table("", { sort: { column: "created", direction: "asc" } });
    expect(ids(result)).toEqual([
      "vercel-ready",
      "daytona-failed",
      "modal-pending",
      "e2b-ready",
      "pending-provider",
    ]);
  });

  it("sorts started with unset values last in both directions", () => {
    const ascending = table("", { sort: { column: "started", direction: "asc" } });
    expect(ids(ascending).slice(0, 3)).toEqual(["modal-pending", "e2b-ready", "vercel-ready"]);
    expect(ids(ascending).slice(3)).toEqual(["daytona-failed", "pending-provider"]);

    const descending = table("", { sort: { column: "started", direction: "desc" } });
    expect(ids(descending).slice(0, 3)).toEqual(["vercel-ready", "e2b-ready", "modal-pending"]);
    expect(ids(descending).slice(3)).toEqual(["daytona-failed", "pending-provider"]);
  });

  it("sorts active duration with inactive rows last", () => {
    const result = table("", { sort: { column: "activeFor", direction: "asc" } });
    expect(ids(result).slice(0, 3)).toEqual(["modal-pending", "vercel-ready", "e2b-ready"]);
    expect(ids(result).slice(3)).toEqual(["daytona-failed", "pending-provider"]);
  });

  it("sorts cost numerically and keeps missing costs last", () => {
    const result = table("", { sort: { column: "cost", direction: "asc" } });
    expect(ids(result)).toEqual([
      "vercel-ready",
      "e2b-ready",
      "modal-pending",
      "daytona-failed",
      "pending-provider",
    ]);
  });

  it("clamps the page when the filtered set shrinks", () => {
    const many = Array.from({ length: 45 }, (_, index) =>
      row({
        id: `row-${index}`,
        created_at: `2026-08-01T00:${String(index).padStart(2, "0")}:00.000Z`,
      }),
    );
    const result = applyResourceTableState(many, {
      query: "",
      sort: null,
      page: 9,
      pageSize: 20,
      now,
    });
    expect(result.page).toBe(3);
    expect(result.pageCount).toBe(3);
    expect(result.from).toBe(41);
    expect(result.to).toBe(45);
    expect(result.rows).toHaveLength(5);
  });

  it("returns an empty page without dropping below page 1", () => {
    const result = table("provider:northflank", { page: 4 });
    expect(result.page).toBe(1);
    expect(result.pageCount).toBe(1);
    expect(result.total).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.from).toBe(0);
    expect(result.to).toBe(0);
  });
});
