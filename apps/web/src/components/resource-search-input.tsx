"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  deleteResourceSearchQualifierAtCaret,
  getResourceSearchSuggestionMode,
  qualifierValueMatchesPrefix,
  tokenizeResourceSearchQuery,
  type ResourceSearchQualifier,
} from "@/lib/resource-table";
import { cn } from "@/lib/utils";

type Suggestion = {
  id: string;
  qualifierKey: string;
  primary: string;
  secondary?: string;
  apply: () => void;
};

type QuerySegment = {
  text: string;
  kind: "text" | "qualifier-prefix";
  qualifierKey?: string;
};

const QUALIFIER_BADGE_CLASS_NAMES: Record<string, string> = {
  provider:
    "bg-slate-500/20 text-slate-800 ring-slate-500/30 dark:bg-slate-400/20 dark:text-slate-200 dark:ring-slate-400/40",
  status:
    "bg-blue-500/20 text-blue-800 ring-blue-500/30 dark:bg-blue-400/20 dark:text-blue-200 dark:ring-blue-400/40",
  type: "bg-violet-500/20 text-violet-800 ring-violet-500/30 dark:bg-violet-400/20 dark:text-violet-200 dark:ring-violet-400/40",
};

function qualifierBadgeClassName(key: string) {
  return QUALIFIER_BADGE_CLASS_NAMES[key] ?? "bg-primary/10 text-primary ring-primary/20";
}

function quoteSearchValue(value: string) {
  return /\s/.test(value) ? `"${value}"` : value;
}

function buildQuerySegments(query: string, qualifiers: ResourceSearchQualifier[]): QuerySegment[] {
  const recognized = new Set(qualifiers.map((qualifier) => qualifier.key));
  const segments: QuerySegment[] = [];
  let cursor = 0;

  for (const token of tokenizeResourceSearchQuery(query)) {
    if (!token.key || !recognized.has(token.key)) {
      continue;
    }
    if (token.start > cursor) {
      segments.push({ text: query.slice(cursor, token.start), kind: "text" });
    }
    const colonOffset = token.raw.indexOf(":");
    const badgeEnd = colonOffset === -1 ? token.end : token.start + colonOffset + 1;
    segments.push({
      text: query.slice(token.start, badgeEnd),
      kind: "qualifier-prefix",
      qualifierKey: token.key,
    });
    if (badgeEnd < token.end) {
      segments.push({ text: query.slice(badgeEnd, token.end), kind: "text" });
    }
    cursor = token.end;
  }

  if (cursor < query.length) {
    segments.push({ text: query.slice(cursor), kind: "text" });
  }

  return segments;
}

function SuggestionPrimary({ suggestion }: { suggestion: Suggestion }) {
  const prefix = `${suggestion.qualifierKey}:`;
  if (!suggestion.primary.startsWith(prefix)) {
    return <span>{suggestion.primary}</span>;
  }

  return (
    <span>
      <span
        className={cn(
          "rounded-sm px-1 py-0.5 ring-1",
          qualifierBadgeClassName(suggestion.qualifierKey),
        )}
      >
        {prefix}
      </span>
      {suggestion.primary.slice(prefix.length)}
    </span>
  );
}

export function ResourceSearchInput({
  query,
  onQueryChange,
  qualifiers,
  placeholder = "provider: e2b",
  className,
  "aria-label": ariaLabel = "Search resources",
}: {
  query: string;
  onQueryChange: (query: string) => void;
  qualifiers: ResourceSearchQualifier[];
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(query.length);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const pendingCaretRef = useRef<number | null>(null);

  useEffect(() => {
    if (pendingCaretRef.current === null) {
      return;
    }
    const position = pendingCaretRef.current;
    pendingCaretRef.current = null;
    const input = inputRef.current;
    if (input) {
      input.focus();
      input.setSelectionRange(position, position);
    }
  });

  const commit = useCallback(
    (next: string, nextCaret: number) => {
      onQueryChange(next);
      setCaret(nextCaret);
      pendingCaretRef.current = nextCaret;
      setOpen(true);
    },
    [onQueryChange],
  );

  const mode = useMemo(
    () => (open ? getResourceSearchSuggestionMode(query, caret) : null),
    [open, query, caret],
  );

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!mode) {
      return [];
    }

    if (mode.kind === "qualifiers") {
      return qualifiers
        .filter((qualifier) => qualifier.key.startsWith(mode.prefix))
        .map((qualifier) => ({
          id: `qualifier-${qualifier.key}`,
          qualifierKey: qualifier.key,
          primary: `${qualifier.key}:`,
          secondary: qualifier.description,
          apply: () => {
            const insert = `${qualifier.key}: `;
            commit(
              query.slice(0, mode.replaceStart) + insert + query.slice(mode.replaceEnd),
              mode.replaceStart + insert.length,
            );
          },
        }));
    }

    const qualifier = qualifiers.find((item) => item.key === mode.qualifier);
    if (!qualifier) {
      return [];
    }

    const prefix = mode.prefix.trim().toLowerCase();
    return qualifier.values
      .filter((option) => qualifierValueMatchesPrefix(option, prefix))
      .map((option, index) => ({
        id: `value-${qualifier.key}-${option.value}-${index}`,
        qualifierKey: qualifier.key,
        primary: `${qualifier.key}: ${quoteSearchValue(option.value)}`,
        secondary:
          option.label.toLowerCase() === option.value.toLowerCase() ? undefined : option.label,
        apply: () => {
          const insert = `${qualifier.key}: ${quoteSearchValue(option.value)} `;
          commit(
            query.slice(0, mode.replaceStart) + insert + query.slice(mode.replaceEnd),
            mode.replaceStart + insert.length,
          );
        },
      }));
  }, [commit, mode, qualifiers, query]);

  const showDropdown = open && suggestions.length > 0;
  const selectedSuggestion =
    suggestions.find((suggestion) => suggestion.id === selectedId) ?? suggestions[0];

  const syncCaret = useCallback(() => {
    const position = inputRef.current?.selectionStart;
    if (typeof position === "number") {
      setCaret(position);
    }
  }, []);

  const syncOverlayScroll = useCallback(() => {
    if (overlayRef.current && inputRef.current) {
      overlayRef.current.scrollLeft = inputRef.current.scrollLeft;
    }
  }, []);

  useEffect(() => {
    syncOverlayScroll();
  }, [query, syncOverlayScroll]);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }

    const selectionStart = event.currentTarget.selectionStart;
    const selectionEnd = event.currentTarget.selectionEnd;
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      typeof selectionStart === "number" &&
      selectionStart === selectionEnd
    ) {
      const removed = deleteResourceSearchQualifierAtCaret(
        query,
        selectionStart,
        event.key === "Delete" ? "forward" : "backward",
      );
      if (removed) {
        event.preventDefault();
        commit(removed.query, removed.caret);
        return;
      }
    }

    if (!showDropdown) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      const currentIndex = suggestions.findIndex(
        (suggestion) => suggestion.id === selectedSuggestion?.id,
      );
      const next = suggestions[(currentIndex + 1) % suggestions.length];
      if (next) {
        setSelectedId(next.id);
      }
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      const currentIndex = suggestions.findIndex(
        (suggestion) => suggestion.id === selectedSuggestion?.id,
      );
      const next = suggestions[(currentIndex - 1 + suggestions.length) % suggestions.length];
      if (next) {
        setSelectedId(next.id);
      }
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectedSuggestion?.apply();
    }
  }

  const showClear = query.length > 0;
  const segments = useMemo(() => buildQuerySegments(query, qualifiers), [query, qualifiers]);

  return (
    <div className={cn("relative w-full", className)}>
      <HugeiconsIcon
        icon={Search01Icon}
        strokeWidth={2}
        className="pointer-events-none absolute top-1/2 left-2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <div
        ref={overlayRef}
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent bg-background py-1 pl-8 text-base text-foreground md:text-sm dark:bg-input/30",
          showClear ? "pr-8" : "pr-2.5",
        )}
      >
        <div className="flex h-full items-center">
          <span className="whitespace-pre">
            {segments.map((segment, index) =>
              segment.kind === "text" ? (
                <span key={index}>{segment.text}</span>
              ) : (
                <span
                  key={index}
                  className={cn(
                    "rounded-sm px-1 -ml-1 mr-0.5 ring-1",
                    qualifierBadgeClassName(segment.qualifierKey ?? ""),
                  )}
                >
                  {segment.text}
                </span>
              ),
            )}
          </span>
        </div>
      </div>
      <input
        ref={inputRef}
        value={query}
        aria-label={ariaLabel}
        aria-expanded={showDropdown}
        aria-controls={showDropdown ? listboxId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={showDropdown ? selectedSuggestion?.id : undefined}
        role="combobox"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder={placeholder}
        className={cn(
          "relative h-8 w-full min-w-0 appearance-none rounded-lg border border-input bg-transparent py-1 pl-8 text-base text-transparent caret-foreground outline-none md:text-sm dark:bg-transparent",
          "[-webkit-text-fill-color:transparent]",
          "placeholder:text-muted-foreground placeholder:[-webkit-text-fill-color:var(--muted-foreground)]",
          "selection:bg-primary selection:text-primary-foreground",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "duration-100 ease-[cubic-bezier(0.32,0.72,0,1)]",
          showClear ? "pr-8" : "pr-2.5",
        )}
        onChange={(event) => {
          onQueryChange(event.target.value);
          const position = event.target.selectionStart;
          setCaret((current) => {
            const next = typeof position === "number" ? position : event.target.value.length;
            return next === current ? current : next;
          });
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={handleKeyDown}
        onSelect={syncCaret}
        onClick={syncCaret}
        onScroll={syncOverlayScroll}
      />
      {showClear ? (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute top-1/2 right-2 z-10 -translate-y-1/2 rounded-sm p-1 text-muted-foreground duration-100 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-foreground"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => commit("", 0)}
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
        </button>
      ) : null}
      {showDropdown ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label={
            mode?.kind === "values" ? `Filter by ${mode.qualifier}` : "Narrow your search"
          }
          onMouseDown={(event) => event.preventDefault()}
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-72 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 ease-[cubic-bezier(0.32,0.72,0,1)]"
        >
          <p className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
            {mode?.kind === "values" ? `Filter by ${mode.qualifier}` : "Narrow your search"}
          </p>
          {suggestions.map((suggestion) => {
            const selected = suggestion.id === selectedSuggestion?.id;
            return (
              <button
                key={suggestion.id}
                id={suggestion.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={cn(
                  "flex w-full cursor-default items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm outline-hidden",
                  selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
                onMouseEnter={() => setSelectedId(suggestion.id)}
                onClick={() => suggestion.apply()}
              >
                <SuggestionPrimary suggestion={suggestion} />
                {suggestion.secondary ? (
                  <span className="truncate text-muted-foreground">{suggestion.secondary}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
