"use client";

/**
 * The receipt photo: one big button that opens the camera, a smaller one for
 * a photo already on the phone. The photo is shrunk here, on the phone,
 * before anything is sent (receipt-photo.ts), then shown so the cleaner can
 * check it is readable, with "Next" and "Take again".
 *
 * "Take photo" opens the page's own camera (CameraScreen, dispatch 21), which
 * shows a frame for the receipt; where the page cannot have the camera, it
 * opens the phone's camera app through a file input, as before. "Choose from
 * phone" is the phone's photo picker, through a file input inside its label,
 * with no script in between.
 *
 * Three lines above the button say how to take the photo. They are what the
 * measurement of 2026-09-30 found the reading needs (CLEANER-COSTS-DESIGN.md
 * §12): flat, straight above, close enough to fill the screen. Crumpling,
 * glare and a busy background did not matter; a receipt small in the frame
 * did.
 */

import { useState, type ChangeEvent } from "react";
import { Camera, Images } from "lucide-react";
import { PhotoError, preparePhoto, type PhotoProblem, type PreparedPhoto } from "@/app/lib/receipt-photo";
import { CameraScreen, canOpenCamera } from "./CameraScreen";
import styles from "./cleaner.module.css";
import { CleanerBar } from "./CleanerBar";

interface PhotoScreenProps {
  propertyName: string;
  /** The prepared photo, as an object URL; null before one is taken. */
  photoUrl: string | null;
  onBack: () => void;
  onPhoto: (photo: PreparedPhoto) => void;
  onNext: () => void;
}

type PhotoState = { kind: "idle" } | { kind: "preparing" } | { kind: "error"; problem: PhotoProblem };

const PROBLEMS: Record<PhotoProblem, string> = {
  unreadable: "This photo can’t be used. Take a new one with the camera.",
  "too-large": "This photo is too big. Take a new one with the camera.",
};

export function PhotoScreen({ propertyName, photoUrl, onBack, onPhoto, onNext }: PhotoScreenProps) {
  const [state, setState] = useState<PhotoState>({ kind: "idle" });
  const [cameraOpen, setCameraOpen] = useState(false);

  /** One photo, from the page's camera or a file input: shrunk, then kept. */
  const take = async (file: File) => {
    setCameraOpen(false);
    setState({ kind: "preparing" });
    try {
      onPhoto(await preparePhoto(file));
      setState({ kind: "idle" });
    } catch (err) {
      setState({ kind: "error", problem: err instanceof PhotoError ? err.problem : "unreadable" });
    }
  };

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Cleared, so choosing the same file again still counts as a choice.
    event.target.value = "";
    if (file) void take(file);
  };

  const preparing = state.kind === "preparing";

  if (cameraOpen) return <CameraScreen onCapture={take} onFile={take} onClose={() => setCameraOpen(false)} />;

  /**
   * Opens the camera, or the phone's photos. The page's own camera when it
   * can be had, so the receipt gets its frame; else the phone's camera app,
   * through the file input. Either way the file goes to `take`.
   */
  const picker = (kind: "camera" | "library", look: string, label: string) => {
    if (kind === "camera" && canOpenCamera()) {
      return (
        <button type="button" className={look} onClick={() => setCameraOpen(true)} disabled={preparing}>
          <Camera aria-hidden />
          <span>{label}</span>
        </button>
      );
    }
    return (
    <label className={`${look} ${preparing ? styles.disabled : ""}`}>
      {kind === "camera" ? <Camera aria-hidden /> : <Images aria-hidden />}
      <span>{label}</span>
      <input
        type="file"
        accept="image/*"
        capture={kind === "camera" ? "environment" : undefined}
        className={styles.fileInput}
        onChange={choose}
        disabled={preparing}
      />
    </label>
    );
  };

  return (
    <>
      <CleanerBar onBack={onBack} title={propertyName} />
      <main className={styles.screen}>
        <h1 className={styles.title}>Photo of the receipt</h1>

        {preparing && (
          <p className={styles.working} role="status">
            <span className={styles.spinner} aria-hidden />
            Getting the photo ready…
          </p>
        )}
        {state.kind === "error" && (
          <p className={styles.problem} role="alert">
            {PROBLEMS[state.problem]}
          </p>
        )}

        {photoUrl ? (
          <>
            <div className={styles.photoPreview}>
              {/* An object URL for a photo taken just now: nothing for next/image to optimise. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoUrl} alt="The receipt photo" />
            </div>
            <div className={styles.buttonStack}>
              <button type="button" className={styles.primary} onClick={onNext} disabled={preparing}>
                Next
              </button>
              {picker("camera", styles.secondary, "Take again")}
            </div>
          </>
        ) : (
          <>
            <ul className={styles.photoTips}>
              <li>Lay the receipt flat.</li>
              <li>Hold the phone straight above it.</li>
              <li>Get close, so the receipt fills the screen.</li>
            </ul>
            <div className={styles.buttonStack}>
              {picker("camera", styles.primary, "Take photo")}
              {picker("library", styles.secondary, "Choose from phone")}
            </div>
          </>
        )}
      </main>
    </>
  );
}
