"use client";

/**
 * "What this place offers" (dispatch 29's editor, moved here): the items by
 * category, each ticked or not, with its icon, its star, Edit and Delete; a
 * row edited in place; an add row with the property's own categories and the
 * standard ones. The rules are in ../../components/offers.ts.
 */

import { Fragment, useState } from "react";
import { Check, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { AdminSelect } from "../../components/AdminSelect";
import { IconPicker } from "../../components/IconPicker";
import { NOT_INCLUDED } from "../../components/offers";
import { TextInput, Tick } from "./controls";
import { STARS_MAX } from "./model";
import { Panel, ScrapeBadge, Tile, fieldIssue, type SectionContext } from "./shared";
import styles from "./editor.module.css";

export function OffersSection({ ctx }: { ctx: SectionContext }) {
  const { draft, rows } = ctx;
  const offers = draft.property.offers ?? [];
  const amenities = draft.property.amenities ?? [];
  const [newName, setNewName] = useState("");
  // No default category (dispatch 29): a new item goes where the admin puts it, never quietly into Bathroom.
  const [newCategory, setNewCategory] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const categories = [...new Set(offers.map((o) => o.category))];
  const categoryChoices = [{ options: rows.categoryOptions.map((value) => ({ value, label: value })) }];

  const add = () => {
    const problem = rows.addOffer(newName, newCategory);
    setAddError(problem);
    if (!problem) setNewName("");
  };

  return (
    <Panel
      title="Offers"
      state={ctx.state}
      note={
        <>
          Everything the place offers, by category. Untick an item to list it under Not included; tick it to offer it again. Star up to {STARS_MAX} as the top amenities on the card{" "}
          {amenities.length > 0 && (
            <span className={styles.countLine}>
              (<b>{amenities.length}</b>/{STARS_MAX} starred)
            </span>
          )}
          . <ScrapeBadge ctx={ctx} field="offers" /> <ScrapeBadge ctx={ctx} field="amenities" />
        </>
      }
    >
      {(fieldIssue(ctx, "offers") || fieldIssue(ctx, "amenities")) && (
        <Tile span={12}>
          <span className={styles.issue} role="alert" data-issue>
            {[fieldIssue(ctx, "offers"), fieldIssue(ctx, "amenities")].filter(Boolean).join(" ")}
          </span>
        </Tile>
      )}

      {categories.map((category) => {
        const inCategory = offers.filter((o) => o.category === category);
        return (
          <Tile key={category} span={6} title={<span className={styles.categoryLabel}>{category}</span>} aside={<span className={styles.categoryCount}>{inCategory.length}</span>}>
            <div className={styles.categoryGroup}>
            {inCategory
              .map((offer) => {
                const realIndex = offers.indexOf(offer);
                const editing = rows.rowEdit?.kind === "offer" && rows.rowEdit.target === offer ? rows.rowEdit : null;
                const starred = amenities.includes(offer.name);
                // An item in "Not included" keeps that category unless it is being included (Kian's ruling).
                const picksCategory = !!editing && (editing.include || offer.category !== NOT_INCLUDED);
                return (
                  <Fragment key={`${realIndex}:${offer.name}`}>
                    <div className={`${styles.row} ${offer.available || editing ? "" : styles.rowUnavailable}`} data-row-edit={editing ? "" : undefined}>
                      <Tick
                        checked={offer.available}
                        disabled={!!editing}
                        onChange={() => rows.toggleOfferAvailable(offer)}
                        label={offer.available ? `${offer.name}: offered` : `${offer.name}: not included`}
                        title={offer.available ? "Offered — untick to move it to Not included" : "Not included — tick to offer it"}
                      />
                      <IconPicker currentIcon={offer.icon || ""} amenityName={offer.name} onSelect={(svg) => rows.updateOfferIcon(offer, svg)} />
                      {editing ? (
                        <>
                          <TextInput
                            field="offers.edit"
                            className={styles.rowEditInput}
                            value={editing.name}
                            autoFocus
                            aria-label="Item name"
                            onChange={(value) => rows.change({ ...editing, name: value })}
                            onKeyDown={rows.keys}
                          />
                          {picksCategory ? (
                            <div className={styles.rowEditCategory}>
                              <AdminSelect label="Category" className={styles.selectFull} value={editing.category} onChange={(category) => rows.change({ ...editing, category })} groups={categoryChoices} placeholder="Pick a category" />
                            </div>
                          ) : (
                            <span className={styles.rowFixedCategory}>{NOT_INCLUDED}</span>
                          )}
                          <div className={styles.rowActions}>
                            <button type="button" className={`${styles.rowBtn} ${styles.rowBtnConfirm}`} title={editing.include ? "Include" : "Save"} aria-label={`${editing.include ? "Include" : "Save"} ${offer.name}`} onClick={rows.commit}>
                              <Check size={14} aria-hidden />
                            </button>
                            <button type="button" className={styles.rowBtn} title="Cancel" aria-label="Cancel" onClick={rows.cancel}>
                              <X size={14} aria-hidden />
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <span className={`${styles.rowText} ${offer.available ? "" : styles.rowNameUnavailable}`} data-offer-name>
                            {offer.name}
                          </span>
                          <div className={styles.rowActions}>
                            <button
                              type="button"
                              className={`${styles.rowBtn} ${styles.starBtn} ${starred ? styles.starBtnOn : ""}`}
                              onClick={() => rows.toggleOfferStar(offer.name)}
                              title={starred ? "Remove from top amenities" : !offer.available ? "Not included — tick it to star it" : amenities.length >= STARS_MAX ? `At most ${STARS_MAX} starred` : "Add to top amenities"}
                              aria-label={starred ? `Unstar ${offer.name}` : `Star ${offer.name}`}
                              aria-pressed={starred}
                              disabled={!starred && (!offer.available || amenities.length >= STARS_MAX)}
                            >
                              <Star size={14} fill={starred ? "#ffb400" : "none"} aria-hidden />
                            </button>
                            <button type="button" className={styles.rowBtn} title="Edit" aria-label={`Edit ${offer.name}`} onClick={() => rows.startOfferEdit(offer)}>
                              <Pencil size={14} aria-hidden />
                            </button>
                            <button type="button" className={`${styles.rowBtn} ${styles.rowBtnDanger}`} title="Delete" aria-label={`Delete ${offer.name}`} onClick={() => rows.deleteOffer(offer)}>
                              <Trash2 size={14} aria-hidden />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                    {editing && rows.rowEditError && (
                      <span className={`${styles.issue} ${styles.rowIssue}`} role="alert">
                        {rows.rowEditError}
                      </span>
                    )}
                  </Fragment>
                );
              })}
            </div>
          </Tile>
        );
      })}

      {/* The name takes the row; the category a fixed width beside it. */}
      <Tile span={12} title="Add an item">
        <div className={styles.addRow} data-field="offers">
          <TextInput
            field="offers.new"
            value={newName}
            onChange={(value) => {
              setNewName(value);
              setAddError(null);
            }}
            placeholder="e.g. Free parking on premises"
            aria-label="New item"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <div className={styles.addCategory}>
            <AdminSelect label="Category of the new item" className={styles.selectFull} value={newCategory} onChange={setNewCategory} groups={categoryChoices} placeholder="Category" />
          </div>
          <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={add} disabled={!newName.trim() || !newCategory} title={newCategory ? undefined : "Pick a category"}>
            <Plus size={15} aria-hidden /> Add
          </button>
        </div>
        {addError && (
          <span className={styles.issue} role="alert">
            {addError}
          </span>
        )}
      </Tile>
    </Panel>
  );
}
