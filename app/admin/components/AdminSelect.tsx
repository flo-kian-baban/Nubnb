"use client";

/**
 * A select for the admin's filter bars (2026-09-30): the same control on
 * every page, drawn by the page rather than by the operating system, so it
 * looks like the rest of the admin — a dark field with a chevron, and a
 * list that opens under it with the chosen option marked.
 *
 * It behaves like a native select: one value, chosen by click or keyboard
 * (arrows, Home and End, Enter, Escape, or typing the first letters), and
 * announced as a combobox with a listbox. With nine options or more a
 * search box sits at the top of the list, so a property is found by typing
 * rather than by scrolling. Options can be grouped, with a heading over
 * each group; a group with nothing to show is left out. An option may carry a
 * second line, grey under its label, which the search matches too: a
 * property's public title under its address (Kian's rulings of 2026-10-15,
 * evening: search everywhere matches both).
 *
 * The field's look comes from the control tokens on the admin container
 * (--ctl-* and --popover-* in ../page.module.css), which every admin control
 * shares.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import styles from "./AdminSelect.module.css";

export interface SelectOption {
  value: string;
  label: string;
  /** A second line, grey under the label; the search matches it too. */
  hint?: string;
}

export interface SelectGroup {
  label?: string;
  options: SelectOption[];
}

interface AdminSelectProps {
  /** What the field is, for a screen reader. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  groups: SelectGroup[];
  icon?: ReactNode;
  /** A search box in the list. Defaults to on from nine options. */
  searchable?: boolean;
  className?: string;
  /** Shown, muted, while the value matches no option (dispatch 30: a field nothing is chosen for yet). */
  placeholder?: string;
  /** Marks the field as refused or missing: the admin's red ring. */
  invalid?: boolean;
  disabled?: boolean;
}

const SEARCH_FROM = 9;
/** Letters typed within this long of each other are one search. */
const TYPE_AHEAD_MS = 700;

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function AdminSelect({ label, value, onChange, groups, icon, searchable, className, placeholder, invalid, disabled }: AdminSelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeRaw, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const typedRef = useRef({ text: "", at: 0 });

  const all = useMemo(
    () => groups.flatMap((group, groupIndex) => group.options.map((option) => ({ ...option, group: groupIndex }))),
    [groups],
  );
  const withSearch = searchable ?? all.length >= SEARCH_FROM;
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return q === "" ? all : all.filter((option) => fold(option.label).includes(q) || (option.hint !== undefined && fold(option.hint).includes(q)));
  }, [all, query]);
  // With a placeholder: an empty value shows the placeholder, and a value that matches no option is shown as it is
  // (a stored "ON" where the list says "Ontario" must not look unset). Without one, the first option stands in.
  const matched = all.find((option) => option.value === value);
  const selected = matched ?? (placeholder === undefined ? all[0] : value === "" ? undefined : { value, label: value });
  // The list can shrink under the search: the highlight stays on a row that exists.
  const active = Math.min(activeRaw, Math.max(0, shown.length - 1));

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setQuery("");
    if (refocus) triggerRef.current?.focus();
  }, []);

  const show = () => {
    setQuery("");
    const index = all.findIndex((option) => option.value === value);
    setActive(index < 0 ? 0 : index);
    setOpen(true);
  };

  const choose = (option: SelectOption) => {
    onChange(option.value);
    close();
  };

  // Open: the keyboard goes to the search box, or to the list.
  useEffect(() => {
    if (open) (withSearch ? searchRef.current : listRef.current)?.focus();
  }, [open, withSearch]);

  // A press outside closes it, without taking the focus back.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  // The highlighted row stays in view.
  useEffect(() => {
    if (open) document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, id]);

  const onListKey = (event: KeyboardEvent<HTMLElement>) => {
    const count = Math.max(1, shown.length);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => (index + 1) % count);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => (index - 1 + count) % count);
        break;
      case "Home":
        event.preventDefault();
        setActive(0);
        break;
      case "End":
        event.preventDefault();
        setActive(shown.length - 1);
        break;
      case "Enter":
        event.preventDefault();
        if (shown[active]) choose(shown[active]);
        break;
      case " ":
        if (withSearch) return;
        event.preventDefault();
        if (shown[active]) choose(shown[active]);
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
      case "Tab":
        close(false);
        break;
      default:
        if (withSearch || event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
        const now = Date.now();
        const typed = typedRef.current;
        typed.text = now - typed.at < TYPE_AHEAD_MS ? typed.text + event.key : event.key;
        typed.at = now;
        const index = shown.findIndex((option) => fold(option.label).startsWith(fold(typed.text)));
        if (index >= 0) setActive(index);
    }
  };

  const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!open) show();
    }
  };

  const activeId = shown[active] ? `${id}-opt-${active}` : undefined;

  return (
    <div ref={rootRef} className={`${styles.root} ${className ?? ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ""} ${invalid ? styles.triggerInvalid : ""}`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={label}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onTriggerKey}
      >
        {icon && (
          <span className={styles.icon} aria-hidden>
            {icon}
          </span>
        )}
        <span className={`${styles.value} ${selected ? "" : styles.placeholder}`}>{selected?.label ?? placeholder ?? ""}</span>
        <ChevronDown size={15} className={styles.chevron} aria-hidden />
      </button>

      {open && (
        <div className={styles.popover}>
          {withSearch && (
            <div className={styles.search}>
              <Search size={14} aria-hidden />
              <input
                ref={searchRef}
                type="text"
                className={styles.searchInput}
                placeholder="Type to find"
                aria-label={`Find in ${label}`}
                aria-controls={`${id}-list`}
                aria-activedescendant={activeId}
                value={query}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onListKey}
              />
            </div>
          )}
          <div
            ref={listRef}
            id={`${id}-list`}
            role="listbox"
            aria-label={label}
            aria-activedescendant={withSearch ? undefined : activeId}
            tabIndex={withSearch ? -1 : 0}
            className={styles.list}
            onKeyDown={withSearch ? undefined : onListKey}
          >
            {shown.length === 0 ? (
              <p className={styles.empty}>Nothing matches</p>
            ) : (
              groups.map((group, groupIndex) => {
                const rows = shown.map((option, index) => ({ option, index })).filter(({ option }) => option.group === groupIndex);
                if (rows.length === 0) return null;
                return (
                  <div key={groupIndex} role={group.label ? "group" : undefined} aria-label={group.label} className={styles.group}>
                    {group.label && (
                      <div className={styles.groupLabel} aria-hidden>
                        {group.label}
                      </div>
                    )}
                    {rows.map(({ option, index }) => (
                      <div
                        key={option.value}
                        id={`${id}-opt-${index}`}
                        role="option"
                        aria-selected={option.value === value}
                        className={`${styles.option} ${index === active ? styles.optionActive : ""} ${option.value === value ? styles.optionSelected : ""}`}
                        onMouseMove={() => setActive(index)}
                        onClick={() => choose(option)}
                      >
                        {option.hint ? (
                          <span className={styles.optionText}>
                            <span className={styles.optionLabel}>{option.label}</span>
                            <span className={styles.optionHint}>{option.hint}</span>
                          </span>
                        ) : (
                          <span className={styles.optionLabel}>{option.label}</span>
                        )}
                        {option.value === value && <Check size={14} aria-hidden />}
                      </div>
                    ))}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
