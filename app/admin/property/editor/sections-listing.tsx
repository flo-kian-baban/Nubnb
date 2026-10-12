"use client";

/**
 * The sections the public sees (dispatch 30): Photos, Basics, Location,
 * Space & price, Highlights, Rules and Reviews. Each is one panel; the editor
 * decides which one shows. The behaviours are the dispatch-29 form's, moved
 * here: uploads go to /api/upload-image as a photo is picked, Get Location
 * fills the coordinates and the address, every list row is edited in place.
 */

import { useRef, useState, type DragEvent } from "react";
import { ArrowLeft, ArrowRight, ImageIcon, ImagePlus, Loader2, MapPin, Plus, Trash2 } from "lucide-react";
import type { Review } from "@/app/types/property";
import { AdminSelect } from "../../components/AdminSelect";
import { NoticeBanner, type Notice } from "../../components/Notice";
import { describeHttpFailure } from "@/app/lib/api/http-failure";
import { Field, NumberInput, Switch, TextArea, TextInput } from "./controls";
import { ACCEPTED_IMAGE_TYPES, CANADIAN_PROVINCES, GTA_CITIES, HIGHLIGHTS_MAX, PHOTOS_WANTED, PROPERTY_TYPES, PROPERTY_TYPE_TAGS } from "./model";
import { ListRow, Panel, ScrapeBadge, Tile, fieldIssue, isInvalid, tint, type SectionContext } from "./shared";
import styles from "./editor.module.css";

const choices = (list: string[]) => [{ options: list.map((value) => ({ value, label: value })) }];

// ─── Photos ───────────────────────────────────────────────────

/**
 * Send one file to /api/upload-image and return the stored URL. Uploads are
 * server-side: there is no Firebase Auth in this app, so the browser has no
 * credential Storage could trust. Rejects with a message fit to show.
 */
async function uploadImageFile(file: File): Promise<string> {
  const body = new FormData();
  body.append("file", file);
  const res = await fetch("/api/upload-image", { method: "POST", body });
  if (!res.ok) {
    const failure = await describeHttpFailure(res, "Upload failed");
    throw new Error([failure.title, failure.detail].filter(Boolean).join(" "));
  }
  const { data } = await res.json();
  if (!data?.url) throw new Error("The server did not return an image URL.");
  return data.url as string;
}

const imageFiles = (list: FileList | File[] | null | undefined) => Array.from(list ?? []).filter((file) => file.type.startsWith("image/"));

export function PhotosSection({ ctx }: { ctx: SectionContext }) {
  const { draft, setProperty, show } = ctx;
  const p = draft.property;
  const images = p.images ?? [];
  const coverRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const total = (p.coverImage ? 1 : 0) + images.length;

  const onCoverFile = async (file: File | undefined) => {
    if (!file) return;
    setUploadingCover(true);
    try {
      const url = await uploadImageFile(file);
      setProperty((prev) => ({ ...prev, coverImage: url }));
      show({ tone: "success", title: `Cover photo uploaded: ${file.name}` });
    } catch (error) {
      show({ tone: "error", title: "Cover photo upload failed.", detail: error instanceof Error ? error.message : "Check your connection and try again." });
    } finally {
      setUploadingCover(false);
    }
  };

  const onGalleryFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(files.length);
    try {
      // allSettled, not all: one rejected file should not discard the ones that uploaded cleanly.
      const results = await Promise.allSettled(files.map(uploadImageFile));
      const urls = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failures = results.flatMap((r, i) => (r.status === "rejected" ? [`${files[i].name}: ${r.reason instanceof Error ? r.reason.message : "upload failed"}`] : []));
      if (urls.length > 0) setProperty((prev) => ({ ...prev, images: [...(prev.images || []), ...urls] }));
      if (failures.length === 0) show({ tone: "success", title: `${urls.length} ${urls.length === 1 ? "photo" : "photos"} uploaded.` });
      else if (urls.length > 0) show({ tone: "warning", title: `${urls.length} of ${files.length} photos uploaded — ${failures.length} failed.`, detail: "The successful ones have been added. The rest were not saved.", items: failures });
      else show({ tone: "error", title: `None of the ${files.length} ${files.length === 1 ? "photo" : "photos"} could be uploaded.`, items: failures });
    } finally {
      setUploading(0);
    }
  };

  const makeCover = (index: number) =>
    setProperty((prev) => {
      const list = prev.images || [];
      const chosen = list[index];
      if (!chosen) return prev;
      const rest = list.filter((_, i) => i !== index);
      return { ...prev, coverImage: chosen, images: prev.coverImage ? [prev.coverImage, ...rest] : rest };
    });
  const move = (index: number, by: -1 | 1) =>
    setProperty((prev) => {
      const list = (prev.images || []).slice();
      const to = index + by;
      if (to < 0 || to >= list.length) return prev;
      [list[index], list[to]] = [list[to], list[index]];
      return { ...prev, images: list };
    });
  const remove = (index: number) => setProperty((prev) => ({ ...prev, images: (prev.images || []).filter((_, i) => i !== index) }));

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void onGalleryFiles(imageFiles(event.dataTransfer.files));
  };

  const busy = uploadingCover || uploading > 0;

  return (
    <Panel title="Photos" state={ctx.state} note={`The cover is the photo on the card and the map. ${PHOTOS_WANTED} photos or more make a full gallery; the first in the gallery shows first.`}>
      {/* The cover */}
      <Tile title="Cover" span={5} aside={<ScrapeBadge ctx={ctx} field="coverImage" />}>
        <div className={styles.cover} data-field="coverImage">
          <div className={`${styles.coverFrame} ${p.coverImage ? "" : styles.coverFrameEmpty}`}>
            {p.coverImage ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.coverImage} alt="Cover photo" className={styles.coverImg} />
                <span className={styles.coverTag}>Cover</span>
              </>
            ) : (
              <div className={styles.coverEmpty}>
                {uploadingCover ? <Loader2 size={26} className={styles.spin} aria-hidden /> : <ImageIcon size={26} aria-hidden />}
                <span>{uploadingCover ? "Uploading…" : "No cover photo yet"}</span>
              </div>
            )}
          </div>
          {fieldIssue(ctx, "coverImage") && (
            <span className={styles.issue} role="alert" data-issue>
              {fieldIssue(ctx, "coverImage")}
            </span>
          )}
          <div className={styles.coverActions}>
            <button type="button" className={`${styles.btn} ${styles.btnGhost}`} disabled={busy} onClick={() => coverRef.current?.click()}>
              {uploadingCover ? <Loader2 size={15} className={styles.spin} aria-hidden /> : <ImageIcon size={15} aria-hidden />}
              <span>{p.coverImage ? "Change cover" : "Add cover photo"}</span>
            </button>
          </div>
          <input ref={coverRef} type="file" accept={ACCEPTED_IMAGE_TYPES} className={styles.fileInput} tabIndex={-1} aria-hidden onChange={(e) => { void onCoverFile(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      </Tile>

      {/* The gallery */}
      <Tile
        title={`Gallery · ${images.length}`}
        span={7}
        aside={
          <>
            <ScrapeBadge ctx={ctx} field="images" />
            <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} disabled={busy} onClick={() => galleryRef.current?.click()}>
              {uploading > 0 ? <Loader2 size={14} className={styles.spin} aria-hidden /> : <ImagePlus size={14} aria-hidden />}
              <span>{uploading > 0 ? `Uploading ${uploading}…` : "Add photos"}</span>
            </button>
          </>
        }
      >
        <div className={styles.gallery} data-field="images">
          {fieldIssue(ctx, "images") && (
            <span className={styles.issue} role="alert" data-issue>
              {fieldIssue(ctx, "images")}
            </span>
          )}
          <div
            className={`${styles.galleryScroll} ${dragging ? styles.galleryScrollActive : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              if (!dragging) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
          <div className={styles.galleryGrid}>
            {images.map((url, index) => (
              <div key={`${index}:${url}`} className={styles.photo}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={`Photo ${index + 1}`} className={styles.photoImg} />
                <span className={styles.photoIndex}>{index + 1}</span>
                <div className={styles.photoActions}>
                  <button type="button" className={styles.photoBtn} title="Move earlier" aria-label={`Move photo ${index + 1} earlier`} disabled={index === 0} onClick={() => move(index, -1)}>
                    <ArrowLeft size={12} aria-hidden />
                  </button>
                  <button type="button" className={styles.photoBtn} title="Make this the cover" aria-label={`Make photo ${index + 1} the cover`} onClick={() => makeCover(index)}>
                    Cover
                  </button>
                  <button type="button" className={`${styles.photoBtn} ${styles.photoBtnDanger}`} title="Remove" aria-label={`Remove photo ${index + 1}`} onClick={() => remove(index)}>
                    <Trash2 size={12} aria-hidden />
                  </button>
                  <button type="button" className={styles.photoBtn} title="Move later" aria-label={`Move photo ${index + 1} later`} disabled={index === images.length - 1} onClick={() => move(index, 1)}>
                    <ArrowRight size={12} aria-hidden />
                  </button>
                </div>
              </div>
            ))}
            <button type="button" className={styles.addPhotos} disabled={busy} onClick={() => galleryRef.current?.click()} aria-label="Add photos">
              <Plus size={18} aria-hidden />
              <span>Add photos</span>
            </button>
            {images.length === 0 && <p className={styles.galleryEmpty}>Drop photos here, or use Add photos.{total === 0 ? "" : " The cover counts as one."}</p>}
          </div>
          </div>
          <input ref={galleryRef} type="file" accept={ACCEPTED_IMAGE_TYPES} multiple className={styles.fileInput} tabIndex={-1} aria-hidden onChange={(e) => { void onGalleryFiles(imageFiles(e.target.files)); e.target.value = ""; }} />
        </div>
      </Tile>
    </Panel>
  );
}

// ─── Basics ───────────────────────────────────────────────────

export function BasicsSection({ ctx }: { ctx: SectionContext }) {
  const { draft, setProperty } = ctx;
  const p = draft.property;
  const set = <K extends "name" | "location" | "type" | "propertyTypeTag" | "description">(key: K) => (value: string) => setProperty((prev) => ({ ...prev, [key]: value }));
  return (
    <Panel title="Basics" state={ctx.state}>
      <Tile title="Listing" span={8}>
        <div className={styles.fields}>
          <Field label="Title" badge={<ScrapeBadge ctx={ctx} field="name" />} issue={fieldIssue(ctx, "name") ?? fieldIssue(ctx, "slug")}>
            <TextInput field="name" value={p.name ?? ""} onChange={set("name")} placeholder="e.g. Modern Villa" invalid={isInvalid(ctx, "name")} tint={tint(ctx, "name")} aria-label="Title" />
          </Field>
          <Field label="Description" badge={<ScrapeBadge ctx={ctx} field="description" />} issue={fieldIssue(ctx, "description")}>
            <TextArea field="description" value={p.description ?? ""} onChange={set("description")} rows={12} placeholder="Describe the property…" invalid={isInvalid(ctx, "description")} tint={tint(ctx, "description")} aria-label="Description" />
          </Field>
        </div>
      </Tile>
      <Tile title="Kind and place" span={4}>
        <div className={styles.fields}>
          <Field label="Display location" field="location" badge={<ScrapeBadge ctx={ctx} field="location" />} issue={fieldIssue(ctx, "location")}>
            <AdminSelect label="Display location" className={styles.selectFull} value={p.location ?? ""} onChange={set("location")} groups={choices(GTA_CITIES)} placeholder="Choose a city" invalid={isInvalid(ctx, "location")} />
          </Field>
          <Field label="Type" field="type" issue={fieldIssue(ctx, "type")}>
            <AdminSelect label="Type" className={styles.selectFull} value={p.type ?? ""} onChange={set("type")} groups={choices(PROPERTY_TYPES)} placeholder="Choose a type" invalid={isInvalid(ctx, "type")} searchable={false} />
          </Field>
          <Field label="Property tag" field="propertyTypeTag" badge={<ScrapeBadge ctx={ctx} field="propertyTypeTag" />} issue={fieldIssue(ctx, "propertyTypeTag")}>
            <AdminSelect label="Property tag" className={styles.selectFull} value={p.propertyTypeTag ?? ""} onChange={set("propertyTypeTag")} groups={choices(PROPERTY_TYPE_TAGS)} placeholder="Choose a tag" invalid={isInvalid(ctx, "propertyTypeTag")} searchable={false} />
          </Field>
        </div>
      </Tile>
    </Panel>
  );
}

// ─── Location ─────────────────────────────────────────────────

/** Get Location, owned by the editor: the link is in the draft; the notice outlives a change of section. */
export interface MapsTool {
  notice: Notice | null;
  locating: boolean;
  locate: () => void;
  dismiss: () => void;
}

export function LocationSection({ ctx, maps }: { ctx: SectionContext; maps: MapsTool }) {
  const { draft, setProperty } = ctx;
  const p = draft.property;
  const [lng, lat] = p.coordinates ?? [0, 0];
  const setAddress = (key: "city" | "state" | "area" | "country") => (value: string) =>
    setProperty((prev) => ({ ...prev, addressDetails: { ...(prev.addressDetails as NonNullable<typeof prev.addressDetails>), [key]: value } }));
  const setDetails = (key: "checkIn" | "checkOut") => (value: string) => setProperty((prev) => ({ ...prev, details: { ...(prev.details as NonNullable<typeof prev.details>), [key]: value } }));

  return (
    <Panel title="Location" state={ctx.state}>
      <Tile title="Google Maps link" span={8}>
        <div className={styles.fields}>
          <Field label="Link" issue={fieldIssue(ctx, "googleMapsUrl")} hint="Get Location fills the coordinates and the address from the link.">
            <div className={styles.inputRow}>
              <div className={styles.inputWrap}>
                <MapPin size={15} aria-hidden />
                <TextInput
                  field="googleMapsUrl"
                  value={p.googleMapsUrl ?? ""}
                  onChange={(value) => setProperty((prev) => ({ ...prev, googleMapsUrl: value }))}
                  placeholder="https://maps.app.goo.gl/… or any Google Maps link"
                  invalid={isInvalid(ctx, "googleMapsUrl")}
                  disabled={maps.locating}
                  aria-label="Google Maps link"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      maps.locate();
                    }
                  }}
                />
              </div>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={maps.locate} disabled={maps.locating || !(p.googleMapsUrl ?? "").trim()}>
                {maps.locating ? <Loader2 size={15} className={styles.spin} aria-hidden /> : <MapPin size={15} aria-hidden />}
                <span>{maps.locating ? "Locating…" : "Get Location"}</span>
              </button>
            </div>
          </Field>
        </div>
        <NoticeBanner notice={maps.notice} onDismiss={maps.dismiss} />
      </Tile>
      <Tile title="Coordinates" span={4}>
        <div className={`${styles.fields} ${styles.cols2}`} data-field="coordinates">
          <Field label="Latitude" issue={fieldIssue(ctx, "coordinates")}>
            <NumberInput field="coordinates.lat" value={lat} onChange={(value) => setProperty((prev) => ({ ...prev, coordinates: [prev.coordinates?.[0] || 0, value] }))} placeholder="43.8561" aria-label="Latitude" />
          </Field>
          <Field label="Longitude">
            <NumberInput field="coordinates.lng" value={lng} onChange={(value) => setProperty((prev) => ({ ...prev, coordinates: [value, prev.coordinates?.[1] || 0] }))} placeholder="-79.3193" aria-label="Longitude" />
          </Field>
        </div>
      </Tile>
      <Tile title="Address" span={8}>
        <div className={`${styles.fields} ${styles.cols2}`}>
          <Field label="City" issue={fieldIssue(ctx, "addressDetails.city")}>
            <TextInput field="addressDetails.city" value={p.addressDetails?.city ?? ""} onChange={setAddress("city")} invalid={isInvalid(ctx, "addressDetails.city")} aria-label="City" />
          </Field>
          <Field label="Province" field="addressDetails.state" issue={fieldIssue(ctx, "addressDetails.state")}>
            <AdminSelect label="Province" className={styles.selectFull} value={p.addressDetails?.state ?? ""} onChange={setAddress("state")} groups={choices(CANADIAN_PROVINCES)} placeholder="Choose a province" invalid={isInvalid(ctx, "addressDetails.state")} />
          </Field>
          <Field label="Area" issue={fieldIssue(ctx, "addressDetails.area")}>
            <TextInput field="addressDetails.area" value={p.addressDetails?.area ?? ""} onChange={setAddress("area")} invalid={isInvalid(ctx, "addressDetails.area")} aria-label="Area" />
          </Field>
          <Field label="Country" issue={fieldIssue(ctx, "addressDetails.country")}>
            <TextInput field="addressDetails.country" value={p.addressDetails?.country ?? ""} onChange={setAddress("country")} invalid={isInvalid(ctx, "addressDetails.country")} aria-label="Country" />
          </Field>
        </div>
      </Tile>
      <Tile title="Check-in and check-out" span={4}>
        <div className={`${styles.fields} ${styles.cols2}`}>
          <Field label="Check-in" badge={<ScrapeBadge ctx={ctx} field="checkIn" />} issue={fieldIssue(ctx, "details.checkIn")}>
            <TextInput field="details.checkIn" value={p.details?.checkIn ?? ""} onChange={setDetails("checkIn")} placeholder="4:00 PM" invalid={isInvalid(ctx, "details.checkIn")} tint={tint(ctx, "checkIn")} aria-label="Check-in time" />
          </Field>
          <Field label="Check-out" badge={<ScrapeBadge ctx={ctx} field="checkOut" />} issue={fieldIssue(ctx, "details.checkOut")}>
            <TextInput field="details.checkOut" value={p.details?.checkOut ?? ""} onChange={setDetails("checkOut")} placeholder="11:00 AM" invalid={isInvalid(ctx, "details.checkOut")} tint={tint(ctx, "checkOut")} aria-label="Check-out time" />
          </Field>
        </div>
      </Tile>
    </Panel>
  );
}

// ─── Space & price ────────────────────────────────────────────

export function SpaceSection({ ctx }: { ctx: SectionContext }) {
  const { draft, setProperty } = ctx;
  const p = draft.property;
  const set = <K extends "bedrooms" | "beds" | "bathrooms" | "guests">(key: K) => (value: number) => setProperty((prev) => ({ ...prev, [key]: value }));
  const setPrice = (key: "nightly" | "weekly" | "monthly" | "weekend" | "cleaningFee" | "minNights") => (value: number) =>
    setProperty((prev) => ({ ...prev, priceInfo: { ...(prev.priceInfo as NonNullable<typeof prev.priceInfo>), [key]: value } }));
  const currency = p.currency || "CAD";

  const priceIssue = fieldIssue(ctx, "priceInfo.nightly") ?? fieldIssue(ctx, "price");
  return (
    <Panel title="Space & price" state={ctx.state}>
      <Tile title="Capacity" span={7}>
        <div className={`${styles.fields} ${styles.cols4}`}>
          <Field label="Bedrooms" badge={<ScrapeBadge ctx={ctx} field="bedrooms" />} issue={fieldIssue(ctx, "bedrooms")} hint="0 for a studio.">
            <NumberInput field="bedrooms" integer value={p.bedrooms ?? 0} onChange={set("bedrooms")} invalid={isInvalid(ctx, "bedrooms")} tint={tint(ctx, "bedrooms")} aria-label="Bedrooms" />
          </Field>
          <Field label="Beds" badge={<ScrapeBadge ctx={ctx} field="beds" />} issue={fieldIssue(ctx, "beds")}>
            <NumberInput field="beds" integer value={p.beds ?? 0} onChange={set("beds")} invalid={isInvalid(ctx, "beds")} tint={tint(ctx, "beds")} aria-label="Beds" />
          </Field>
          <Field label="Bathrooms" badge={<ScrapeBadge ctx={ctx} field="bathrooms" />} issue={fieldIssue(ctx, "bathrooms")}>
            <NumberInput field="bathrooms" value={p.bathrooms ?? 0} onChange={set("bathrooms")} invalid={isInvalid(ctx, "bathrooms")} tint={tint(ctx, "bathrooms")} aria-label="Bathrooms" />
          </Field>
          <Field label="Max guests" badge={<ScrapeBadge ctx={ctx} field="guests" />} issue={fieldIssue(ctx, "guests")}>
            <NumberInput field="guests" integer value={p.guests ?? 0} onChange={set("guests")} invalid={isInvalid(ctx, "guests")} tint={tint(ctx, "guests")} aria-label="Max guests" />
          </Field>
        </div>
      </Tile>
      {/* One price: written to both `priceInfo.nightly` and the legacy `price` on save, so the two cannot diverge again. */}
      <Tile title={`Nightly price (${currency})`} span={5} aside={<ScrapeBadge ctx={ctx} field="price" />}>
        <div className={styles.heroPrefix}>
          <span aria-hidden>$</span>
          <NumberInput field="priceInfo.nightly" className={styles.heroInput} value={p.priceInfo?.nightly ?? 0} onChange={setPrice("nightly")} invalid={isInvalid(ctx, "priceInfo.nightly") || isInvalid(ctx, "price")} tint={tint(ctx, "price")} aria-label="Nightly price" />
        </div>
        {priceIssue && (
          <span className={styles.issue} role="alert" data-issue>
            {priceIssue}
          </span>
        )}
        <span className={styles.hint}>The price shown on cards, map pins and the property page.</span>
      </Tile>
      <Tile title="Stay and fees" span={7}>
        <div className={`${styles.fields} ${styles.cols3}`}>
          <Field label="Minimum nights" issue={fieldIssue(ctx, "priceInfo.minNights")}>
            <NumberInput field="priceInfo.minNights" integer value={p.priceInfo?.minNights ?? 0} onChange={setPrice("minNights")} invalid={isInvalid(ctx, "priceInfo.minNights")} aria-label="Minimum nights" />
          </Field>
          <Field label="Cleaning fee" issue={fieldIssue(ctx, "priceInfo.cleaningFee")}>
            <NumberInput field="priceInfo.cleaningFee" value={p.priceInfo?.cleaningFee ?? 0} onChange={setPrice("cleaningFee")} invalid={isInvalid(ctx, "priceInfo.cleaningFee")} aria-label="Cleaning fee" />
          </Field>
          <Field label="Weekend price" issue={fieldIssue(ctx, "priceInfo.weekend")}>
            <NumberInput field="priceInfo.weekend" value={p.priceInfo?.weekend ?? 0} onChange={setPrice("weekend")} invalid={isInvalid(ctx, "priceInfo.weekend")} aria-label="Weekend price" />
          </Field>
        </div>
      </Tile>
      <Tile title="Stored only" span={5} aside="Shown nowhere">
        <div className={`${styles.fields} ${styles.cols2}`}>
          <Field label="Weekly price" issue={fieldIssue(ctx, "priceInfo.weekly")}>
            <NumberInput field="priceInfo.weekly" value={p.priceInfo?.weekly ?? 0} onChange={setPrice("weekly")} invalid={isInvalid(ctx, "priceInfo.weekly")} aria-label="Weekly price" />
          </Field>
          <Field label="Monthly price" issue={fieldIssue(ctx, "priceInfo.monthly")}>
            <NumberInput field="priceInfo.monthly" value={p.priceInfo?.monthly ?? 0} onChange={setPrice("monthly")} invalid={isInvalid(ctx, "priceInfo.monthly")} aria-label="Monthly price" />
          </Field>
        </div>
      </Tile>
    </Panel>
  );
}

// ─── Highlights ───────────────────────────────────────────────

export function HighlightsSection({ ctx }: { ctx: SectionContext }) {
  const [text, setText] = useState("");
  const highlights = ctx.draft.property.highlights ?? [];
  const add = () => {
    if (ctx.rows.addHighlight(text)) setText("");
  };
  return (
    <Panel title="Highlights" state={ctx.state} note={<>Up to {HIGHLIGHTS_MAX} badges on the property&apos;s card, like &ldquo;City view&rdquo; or &ldquo;Self check-in&rdquo;.</>}>
      <Tile title="Badges on the card" span={8} aside={<ScrapeBadge ctx={ctx} field="highlights" />}>
        {fieldIssue(ctx, "highlights") && (
          <span className={styles.issue} role="alert" data-issue>
            {fieldIssue(ctx, "highlights")}
          </span>
        )}
        <div className={styles.list} data-field="highlights">
          {highlights.map((h, i) => (
            <ListRow key={`${i}:${h}`} kind="highlight" text={h} index={i} rows={ctx.rows} />
          ))}
          {highlights.length < HIGHLIGHTS_MAX && (
            <div className={styles.addRow}>
              <TextInput
                field="highlights.new"
                value={text}
                onChange={setText}
                placeholder="e.g. City skyline view"
                aria-label="New highlight"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    add();
                  }
                }}
              />
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={add} disabled={!text.trim()}>
                <Plus size={15} aria-hidden /> Add
              </button>
            </div>
          )}
        </div>
      </Tile>
    </Panel>
  );
}

// ─── Rules ────────────────────────────────────────────────────

export function RulesSection({ ctx }: { ctx: SectionContext }) {
  const { draft, setProperty } = ctx;
  const p = draft.property;
  const [text, setText] = useState("");
  const rules = p.terms?.rules ?? [];
  const setTerm = (key: "smokingAllowed" | "petsAllowed" | "partyAllowed" | "childrenAllowed") => (checked: boolean) =>
    setProperty((prev) => ({ ...prev, terms: { ...(prev.terms as NonNullable<typeof prev.terms>), [key]: checked } }));
  const add = () => {
    if (ctx.rows.addRule(text)) setText("");
  };
  return (
    <Panel title="Rules" state={ctx.state}>
      <Tile title="Cancellation policy" span={5}>
        <TextInput field="terms.cancellationPolicy" value={p.terms?.cancellationPolicy ?? ""} onChange={(value) => setProperty((prev) => ({ ...prev, terms: { ...(prev.terms as NonNullable<typeof prev.terms>), cancellationPolicy: value } }))} placeholder="e.g. Firm — no cancellation" invalid={isInvalid(ctx, "terms.cancellationPolicy")} aria-label="Cancellation policy" />
        {fieldIssue(ctx, "terms.cancellationPolicy") && (
          <span className={styles.issue} role="alert" data-issue>
            {fieldIssue(ctx, "terms.cancellationPolicy")}
          </span>
        )}
      </Tile>
      <Tile title="Allowed" span={7}>
        <div className={styles.switchGroup}>
          <Switch bare label="Smoking" checked={!!p.terms?.smokingAllowed} onChange={setTerm("smokingAllowed")} field="terms.smokingAllowed" badge={<ScrapeBadge ctx={ctx} field="smokingAllowed" />} />
          <Switch bare label="Pets" checked={!!p.terms?.petsAllowed} onChange={setTerm("petsAllowed")} field="terms.petsAllowed" badge={<ScrapeBadge ctx={ctx} field="petsAllowed" />} />
          <Switch bare label="Parties and events" checked={!!p.terms?.partyAllowed} onChange={setTerm("partyAllowed")} field="terms.partyAllowed" badge={<ScrapeBadge ctx={ctx} field="partyAllowed" />} />
          <Switch bare label="Children" checked={!!p.terms?.childrenAllowed} onChange={setTerm("childrenAllowed")} field="terms.childrenAllowed" />
        </div>
      </Tile>
      <Tile title="House rules" span={12} aside={<ScrapeBadge ctx={ctx} field="rules" />}>
        {fieldIssue(ctx, "terms.rules") && (
          <span className={styles.issue} role="alert" data-issue>
            {fieldIssue(ctx, "terms.rules")}
          </span>
        )}
        <div className={styles.list} data-field="terms.rules">
          {rules.map((rule, i) => (
            <ListRow key={`${i}:${rule}`} kind="rule" text={rule} index={i} rows={ctx.rows} />
          ))}
          <div className={styles.addRow}>
            <TextInput
              field="terms.rules.new"
              value={text}
              onChange={setText}
              placeholder="e.g. No noise after 10 PM"
              aria-label="New house rule"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
            <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={add} disabled={!text.trim()}>
              <Plus size={15} aria-hidden /> Add
            </button>
          </div>
        </div>
      </Tile>
    </Panel>
  );
}

// ─── Reviews ──────────────────────────────────────────────────

export function ReviewsSection({ ctx }: { ctx: SectionContext }) {
  const { draft, setProperty } = ctx;
  const p = draft.property;
  const reviews: Review[] = p.reviews ?? [];
  const remove = (index: number) => setProperty((prev) => ({ ...prev, reviews: (prev.reviews || []).filter((_, i) => i !== index) }));
  return (
    <Panel
      title="Reviews"
      state={ctx.state}
      note={
        ctx.fieldStatus ? (
          <>
            <ScrapeBadge ctx={ctx} field="reviews" /> <ScrapeBadge ctx={ctx} field="averageRating" /> <ScrapeBadge ctx={ctx} field="totalReviewCount" />
          </>
        ) : undefined
      }
    >
      <Tile title="Rating on Airbnb" span={4}>
        <div>
          <div className={styles.figure}>{p.averageRating ? `★ ${Number(p.averageRating).toFixed(2)}` : "—"}</div>
          <div className={styles.figureLabel}>
            {p.totalReviewCount ? `${p.totalReviewCount} ${p.totalReviewCount === 1 ? "review" : "reviews"} on Airbnb` : "No count imported"} · {reviews.length} imported
          </div>
        </div>
      </Tile>
      <Tile title="Imported reviews" span={8}>
        {reviews.length === 0 ? (
          <div className={styles.empty}>No reviews imported. Importing the Airbnb listing brings its reviews.</div>
        ) : (
          <div className={styles.list}>
            {reviews.map((review, index) => (
              <div key={`${index}:${review.reviewer}:${review.date}`} className={styles.reviewCard}>
                <div className={styles.reviewHead}>
                  {review.avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={review.avatar} alt="" className={styles.reviewAvatar} />
                  ) : (
                    <div className={styles.reviewAvatarFallback} aria-hidden>
                      {review.reviewer.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className={styles.reviewMeta}>
                    <div className={styles.reviewName}>{review.reviewer}</div>
                    <div className={styles.reviewDate}>{review.date}</div>
                  </div>
                  <span className={styles.reviewStars} aria-label={`${review.rating} stars`}>
                    {"★".repeat(Math.max(0, Math.min(5, Math.round(review.rating))))}
                  </span>
                  <button type="button" className={`${styles.rowBtn} ${styles.rowBtnDanger}`} title="Delete review" aria-label={`Delete the review by ${review.reviewer}`} onClick={() => remove(index)}>
                    <Trash2 size={14} aria-hidden />
                  </button>
                </div>
                <p className={styles.reviewText}>{review.text}</p>
              </div>
            ))}
          </div>
        )}
      </Tile>
    </Panel>
  );
}
