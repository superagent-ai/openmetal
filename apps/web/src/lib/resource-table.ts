export const RESOURCE_TABLE_PAGE_SIZE = 20;
export const PENDING_PROVIDER_FILTER = "pending";
export const RESOURCE_SEARCH_QUALIFIER_KEYS = ["provider", "status", "type"] as const;
export const KNOWN_SANDBOX_PROVIDERS = [
  "blaxel",
  "cloudflare",
  "codesandbox",
  "daytona",
  "e2b",
  "modal",
  "northflank",
  "runloop",
  "vercel",
] as const;
export const SANDBOX_STATES = [
  "requested",
  "routing",
  "provisioning",
  "provision_unknown",
  "ready",
  "pausing",
  "paused",
  "resuming",
  "runtime_unknown",
  "stopping",
  "stopped",
  "failed",
  "cleanup_pending",
  "cleanup_failed",
] as const;

export type ResourceSearchQualifierKey = (typeof RESOURCE_SEARCH_QUALIFIER_KEYS)[number];

export type ResourceTableSortColumn =
  "provider" | "status" | "created" | "started" | "activeFor" | "cost";

export type ResourceTableSort = {
  column: ResourceTableSortColumn;
  direction: "asc" | "desc";
} | null;

export type ResourceTableRow = {
  id: string;
  type?: string;
  provider: string | null;
  state: string;
  created_at: string;
  ready_at: string | null;
  paused_at: string | null;
  stopped_at: string | null;
  cost_microusd: string | null;
};

export type ResourceSearchQuery = {
  providers: string[];
  statuses: string[];
  types: string[];
  terms: string[];
};

export type ResourceSearchToken = {
  start: number;
  end: number;
  raw: string;
  key: ResourceSearchQualifierKey | null;
  value: string;
};

export type ResourceSearchQualifierOption = {
  value: string;
  label: string;
};

export type ResourceSearchQualifier = {
  key: ResourceSearchQualifierKey;
  description: string;
  values: ResourceSearchQualifierOption[];
};

export type ResourceSearchSuggestionMode =
  | {
      kind: "qualifiers";
      prefix: string;
      replaceStart: number;
      replaceEnd: number;
    }
  | {
      kind: "values";
      qualifier: ResourceSearchQualifierKey;
      prefix: string;
      replaceStart: number;
      replaceEnd: number;
    };

const QUALIFIER_KEYS = new Set<string>(RESOURCE_SEARCH_QUALIFIER_KEYS);

export function providerFilterKey(provider: string | null) {
  return provider ?? PENDING_PROVIDER_FILTER;
}

export function providerLabel(provider: string | null) {
  if (!provider) {
    return "Pending";
  }
  if (provider === "codesandbox") {
    return "CodeSandbox";
  }
  if (provider === "e2b") {
    return "E2B";
  }
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function statusLabel(state: string) {
  return state.replaceAll("_", " ");
}

export function normalizeProviderToken(value: string) {
  const compact = value.trim().toLowerCase().replaceAll(" ", "");
  if (compact === "pending") {
    return PENDING_PROVIDER_FILTER;
  }
  return compact;
}

export function normalizeStatusToken(value: string) {
  return value.trim().toLowerCase().replaceAll(" ", "_");
}

export function tokenizeResourceSearchQuery(query: string): ResourceSearchToken[] {
  const tokens: ResourceSearchToken[] = [];
  let index = 0;

  while (index < query.length) {
    if (/\s/.test(query[index]!)) {
      index += 1;
      continue;
    }

    const start = index;
    let inQuotes = false;
    let colonIndex = -1;

    while (index < query.length) {
      const char = query[index]!;
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (!inQuotes && /\s/.test(char)) {
        break;
      } else if (!inQuotes && char === ":" && colonIndex === -1) {
        colonIndex = index;
      }
      index += 1;
    }

    let end = index;
    let key: ResourceSearchQualifierKey | null = null;
    if (colonIndex > start) {
      const candidate = query.slice(start, colonIndex).toLowerCase();
      if (QUALIFIER_KEYS.has(candidate)) {
        key = candidate as ResourceSearchQualifierKey;
      }
    }

    if (key) {
      let valueStart = colonIndex + 1;
      // Support GitHub/landing form `key: value` and keep `key:value` compatible.
      if (valueStart === end) {
        let lookahead = end;
        while (lookahead < query.length && /\s/.test(query[lookahead]!)) {
          lookahead += 1;
        }
        valueStart = lookahead;
        end = lookahead;

        if (lookahead < query.length) {
          let inValueQuotes = false;
          while (end < query.length) {
            const char = query[end]!;
            if (char === '"') {
              inValueQuotes = !inValueQuotes;
            } else if (!inValueQuotes && /\s/.test(char)) {
              break;
            }
            end += 1;
          }
        }
        index = end;
      }

      tokens.push({
        start,
        end,
        raw: query.slice(start, end),
        key,
        value: query.slice(valueStart, end).replaceAll('"', "").trim(),
      });
    } else {
      tokens.push({
        start,
        end,
        raw: query.slice(start, end),
        key: null,
        value: query.slice(start, end).replaceAll('"', ""),
      });
    }
  }

  return tokens;
}

export function parseResourceSearchQuery(query: string): ResourceSearchQuery {
  const providers: string[] = [];
  const statuses: string[] = [];
  const types: string[] = [];
  const terms: string[] = [];

  for (const token of tokenizeResourceSearchQuery(query)) {
    if (token.key === "provider") {
      if (token.value) {
        providers.push(normalizeProviderToken(token.value));
      }
      continue;
    }
    if (token.key === "status") {
      if (token.value) {
        statuses.push(normalizeStatusToken(token.value));
      }
      continue;
    }
    if (token.key === "type") {
      if (token.value) {
        types.push(token.value.toLowerCase());
      }
      continue;
    }
    const term = token.value.trim().toLowerCase();
    if (term) {
      terms.push(term);
    }
  }

  return { providers, statuses, types, terms };
}

export function serializeResourceSearchQuery(parsed: ResourceSearchQuery) {
  return [
    ...parsed.providers.map((value) => `provider: ${value}`),
    ...parsed.statuses.map((value) => `status: ${value}`),
    ...parsed.types.map((value) => `type: ${value}`),
    ...parsed.terms,
  ].join(" ");
}

export function getResourceSearchSuggestionMode(
  query: string,
  caret: number,
): ResourceSearchSuggestionMode {
  const tokens = tokenizeResourceSearchQuery(query);
  const token = tokens.find((item) => caret > item.start && caret <= item.end);

  if (!token) {
    return {
      kind: "qualifiers",
      prefix: "",
      replaceStart: caret,
      replaceEnd: caret,
    };
  }

  if (token.key) {
    return {
      kind: "values",
      qualifier: token.key,
      prefix: token.value,
      replaceStart: token.start,
      replaceEnd: token.end,
    };
  }

  return {
    kind: "qualifiers",
    prefix: token.raw.toLowerCase(),
    replaceStart: token.start,
    replaceEnd: token.end,
  };
}

function qualifierValueStart(query: string, token: ResourceSearchToken) {
  const colonOffset = token.raw.indexOf(":");
  const badgeEnd = colonOffset === -1 ? token.end : token.start + colonOffset + 1;
  let valueStart = badgeEnd;
  while (valueStart < token.end && /\s/.test(query[valueStart]!)) {
    valueStart += 1;
  }
  return { badgeEnd, valueStart, hasValue: valueStart < token.end };
}

function rangeAfterToken(query: string, token: ResourceSearchToken) {
  let end = token.end;
  while (end < query.length && /\s/.test(query[end]!)) {
    end += 1;
  }
  return { start: token.start, end };
}

export function deleteResourceSearchQualifierAtCaret(
  query: string,
  caret: number,
  direction: "backward" | "forward" = "backward",
) {
  if (query.length === 0) {
    return null;
  }
  const tokens = tokenizeResourceSearchQuery(query).filter((token) => token.key);

  if (direction === "forward") {
    if (caret >= query.length) {
      return null;
    }
    const token = tokens.find((item) => caret >= item.start && caret < item.end);
    if (!token) {
      return null;
    }
    const { valueStart } = qualifierValueStart(query, token);
    if (caret >= valueStart) {
      return null;
    }
    const range = rangeAfterToken(query, token);
    return {
      query: query.slice(0, range.start) + query.slice(range.end),
      caret: range.start,
    };
  }

  if (caret <= 0) {
    return null;
  }

  const deleteIndex = caret - 1;
  const containing = tokens.find((token) => deleteIndex >= token.start && deleteIndex < token.end);
  if (containing) {
    const { valueStart } = qualifierValueStart(query, containing);
    if (deleteIndex >= valueStart) {
      return null;
    }
    const range = rangeAfterToken(query, containing);
    return {
      query: query.slice(0, range.start) + query.slice(range.end),
      caret: range.start,
    };
  }

  const previous = [...tokens].reverse().find((token) => token.end <= deleteIndex);
  if (!previous) {
    return null;
  }
  const between = query.slice(previous.end, caret);
  const nextToken = tokens.find((token) => token.start >= previous.end);
  if (between.length > 0 && /^\s+$/.test(between) && (!nextToken || nextToken.start >= caret)) {
    return {
      query: query.slice(0, previous.start) + query.slice(caret),
      caret: previous.start,
    };
  }

  return null;
}

export function resourceSearchQualifiers(options?: {
  extraProviders?: ResourceSearchQualifierOption[];
  extraStatuses?: ResourceSearchQualifierOption[];
}): ResourceSearchQualifier[] {
  const providers = new Map<string, string>();
  for (const provider of KNOWN_SANDBOX_PROVIDERS) {
    providers.set(provider, providerLabel(provider));
  }
  providers.set(PENDING_PROVIDER_FILTER, providerLabel(null));
  for (const option of options?.extraProviders ?? []) {
    providers.set(option.value, option.label);
  }

  const statuses = new Map<string, string>();
  for (const state of SANDBOX_STATES) {
    statuses.set(state, statusLabel(state));
  }
  for (const option of options?.extraStatuses ?? []) {
    statuses.set(option.value, option.label);
  }

  return [
    {
      key: "provider",
      description: "Sandbox provider",
      values: [...providers.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((left, right) => left.label.localeCompare(right.label, "en")),
    },
    {
      key: "status",
      description: "Resource status",
      values: [...statuses.entries()]
        .map(([value, label]) => ({ value, label }))
        .sort((left, right) => left.label.localeCompare(right.label, "en")),
    },
    {
      key: "type",
      description: "Resource type",
      values: [{ value: "sandbox", label: "Sandbox" }],
    },
  ];
}

export function toggleSearchQualifier(
  query: string,
  qualifier: "provider" | "status" | "type",
  value: string,
) {
  const parsed = parseResourceSearchQuery(query);
  const key =
    qualifier === "provider" ? "providers" : qualifier === "status" ? "statuses" : "types";
  const current = parsed[key];
  parsed[key] = current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
  return serializeResourceSearchQuery(parsed);
}

export function applyResourceTableState<T extends ResourceTableRow>(
  rows: readonly T[],
  options: {
    query?: string;
    sort: ResourceTableSort;
    page: number;
    pageSize?: number;
    now: number;
  },
) {
  const parsed = parseResourceSearchQuery(options.query ?? "");
  const pageSize = options.pageSize ?? RESOURCE_TABLE_PAGE_SIZE;
  const providerFacets = new Map<string, number>();
  const statusFacets = new Map<string, number>();

  for (const row of rows) {
    const providerKey = providerFilterKey(row.provider);
    providerFacets.set(providerKey, (providerFacets.get(providerKey) ?? 0) + 1);
    statusFacets.set(row.state, (statusFacets.get(row.state) ?? 0) + 1);
  }

  const filtered = rows.filter((row) => rowMatchesSearch(row, parsed));
  const originalIndex = new Map(rows.map((row, index) => [row.id, index]));
  const sort = options.sort;
  const sorted = sort
    ? [...filtered].sort((left, right) => {
        const comparison = compareRows(left, right, sort, options.now);
        if (comparison !== 0) {
          return comparison;
        }
        return (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0);
      })
    : filtered;

  const total = sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, options.page), pageCount);
  const start = (page - 1) * pageSize;

  return {
    rows: sorted.slice(start, start + pageSize),
    total,
    page,
    pageCount,
    pageSize,
    from: total === 0 ? 0 : start + 1,
    to: Math.min(start + pageSize, total),
    providerFacets,
    statusFacets,
    parsed,
  };
}

export function qualifierValueMatchesPrefix(option: ResourceSearchQualifierOption, prefix: string) {
  const needle = prefix.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  return (
    option.value.toLowerCase().startsWith(needle) || option.label.toLowerCase().startsWith(needle)
  );
}

function matchesProviderToken(row: ResourceTableRow, value: string) {
  const key = providerFilterKey(row.provider);
  const label = providerLabel(row.provider).toLowerCase();
  return key === value || key.startsWith(value) || label.startsWith(value);
}

function matchesStatusToken(row: ResourceTableRow, value: string) {
  const state = row.state.toLowerCase();
  const label = statusLabel(row.state).toLowerCase();
  return state === value || state.startsWith(value) || label.startsWith(value);
}

function matchesTypeToken(row: ResourceTableRow, value: string) {
  const type = (row.type ?? "sandbox").toLowerCase();
  return type === value || type.startsWith(value);
}

function rowMatchesSearch(row: ResourceTableRow, parsed: ResourceSearchQuery) {
  if (
    parsed.providers.length > 0 &&
    !parsed.providers.some((value) => matchesProviderToken(row, value))
  ) {
    return false;
  }
  if (
    parsed.statuses.length > 0 &&
    !parsed.statuses.some((value) => matchesStatusToken(row, value))
  ) {
    return false;
  }
  if (parsed.types.length > 0 && !parsed.types.some((value) => matchesTypeToken(row, value))) {
    return false;
  }
  if (parsed.terms.length === 0) {
    return true;
  }
  const haystack = [
    row.id,
    row.type ?? "sandbox",
    row.provider ?? "",
    providerLabel(row.provider),
    row.state,
    statusLabel(row.state),
  ]
    .join(" ")
    .toLowerCase();
  return parsed.terms.every((term) => haystack.includes(term));
}

function compareRows(
  left: ResourceTableRow,
  right: ResourceTableRow,
  sort: Exclude<ResourceTableSort, null>,
  now: number,
) {
  const direction = sort.direction === "asc" ? 1 : -1;
  switch (sort.column) {
    case "provider":
      return (
        direction * providerLabel(left.provider).localeCompare(providerLabel(right.provider), "en")
      );
    case "status":
      return direction * left.state.localeCompare(right.state, "en");
    case "created":
      return direction * (Date.parse(left.created_at) - Date.parse(right.created_at));
    case "started":
      return compareMissingLast(
        startedAt(left),
        startedAt(right),
        (leftValue, rightValue) => leftValue - rightValue,
        sort.direction,
      );
    case "activeFor":
      return compareMissingLast(
        activeDurationMs(left, now),
        activeDurationMs(right, now),
        (leftValue, rightValue) => leftValue - rightValue,
        sort.direction,
      );
    case "cost":
      return compareMissingLast(
        costValue(left),
        costValue(right),
        (leftValue, rightValue) => (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0),
        sort.direction,
      );
  }
}

function compareMissingLast<T>(
  left: T | null,
  right: T | null,
  compare: (left: T, right: T) => number,
  direction: "asc" | "desc",
) {
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  const comparison = compare(left, right);
  return direction === "asc" ? comparison : -comparison;
}

function startedAt(row: ResourceTableRow) {
  return row.ready_at ? Date.parse(row.ready_at) : null;
}

function activeDurationMs(row: ResourceTableRow, now: number) {
  if (!row.ready_at || now === 0) {
    return null;
  }
  const endedAt = row.paused_at ?? row.stopped_at;
  return Math.max(0, (endedAt ? Date.parse(endedAt) : now) - Date.parse(row.ready_at));
}

function costValue(row: ResourceTableRow) {
  if (row.provider === "modal" || row.cost_microusd === null) {
    return null;
  }
  return BigInt(row.cost_microusd);
}
