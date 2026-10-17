"use client";

/**
 * The in-page camera (dispatch 21): the phone's back camera in a full-screen
 * view with a frame showing where to put the receipt, and one big shutter.
 * Adding a receipt starts here (Kian's ruling 4 of 2026-10-16): "Add a
 * receipt" opens it at once, and "Take again" on the receipt opens it again.
 *
 * The frame is a guide, nothing more. The whole picture is kept, whatever is
 * inside or outside the frame; nothing is detected, cropped or refused. It
 * works on iPhone (Safari) and Android (Chrome) alike, because both give a
 * page the camera through getUserMedia on a secure page.
 *
 * "Photos", beside the shutter, picks a photo already on the phone (the
 * phone's photo picker, through a file input inside its label, with no
 * script in between), as "Choose from phone" did before.
 *
 * When the camera cannot be had — permission refused, no camera, an old
 * browser — the screen says so and offers the phone's own camera app, which
 * is what the app used before (a file input with `capture`), and its photos.
 * The photo taken here goes through the same preparation as one from that
 * app (receipt-photo.ts), so what is sent is the same either way; while it
 * is prepared the screen says so, and a photo that cannot be used is said
 * here, with the camera still open for another.
 *
 * Client-only. The stream is stopped when the screen closes.
 */

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Camera, Images, X } from "lucide-react";
import styles from "./cleaner.module.css";

interface CameraScreenProps {
  /** The photo, as a JPEG file, the moment the shutter is pressed. */
  onCapture: (file: File) => void;
  /** A file from the phone's own camera app or its photos. */
  onFile: (file: File) => void;
  onClose: () => void;
  /** True while the photo just taken is being prepared. */
  preparing: boolean;
  /** Why the last photo could not be used, in a few words; null when nothing is wrong. */
  problem: string | null;
  /** A line from the app to show over the camera (a photo the server refused); null for none. */
  notice: string | null;
}

type CameraState = { kind: "starting" } | { kind: "live" } | { kind: "unavailable"; why: string };

const NO_CAMERA = "The camera can’t be used here. Use the phone’s camera instead.";

/** Whether this page can open the camera itself. */
export function canOpenCamera(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === "function";
}

export function CameraScreen({ onCapture, onFile, onClose, preparing, problem, notice }: CameraScreenProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>({ kind: "starting" });
  const [taking, setTaking] = useState(false);

  // Open the back camera at the highest size it offers; stop it on the way out.
  useEffect(() => {
    let cancelled = false;
    const open = async () => {
      try {
        if (!canOpenCamera()) throw new Error("no camera here");
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 4032 }, height: { ideal: 3024 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        setState({ kind: "live" });
      } catch {
        if (!cancelled) setState({ kind: "unavailable", why: NO_CAMERA });
      }
    };
    void open();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, []);

  // A photo that could not be used: the shutter is free again for another.
  useEffect(() => {
    if (problem) setTaking(false);
  }, [problem]);

  /** The frame as it is, at the camera's own size, as a JPEG. */
  const take = useCallback(async () => {
    const video = videoRef.current;
    if (!video || taking || preparing || state.kind !== "live") return;
    setTaking(true);
    try {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width === 0 || height === 0) throw new Error("no frame");
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no canvas");
      context.drawImage(video, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      canvas.width = 0;
      canvas.height = 0;
      if (!blob) throw new Error("no image");
      onCapture(new File([blob], "receipt.jpg", { type: "image/jpeg" }));
    } catch {
      setState({ kind: "unavailable", why: NO_CAMERA });
      setTaking(false);
    }
  }, [onCapture, preparing, state.kind, taking]);

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onFile(file);
  };

  /** The phone's photos, through a file input inside its label. */
  const photos = (look: string, label: string) => (
    <label className={`${look} ${preparing ? styles.disabled : ""}`}>
      <Images aria-hidden />
      <span>{label}</span>
      <input type="file" accept="image/*" className={styles.fileInput} onChange={chooseFile} disabled={preparing} />
    </label>
  );

  const message = problem ?? notice;

  return (
    <div className={styles.camera} role="dialog" aria-modal="true" aria-label="Camera">
      <video ref={videoRef} className={styles.cameraVideo} playsInline muted autoPlay />

      {state.kind === "live" && (
        <div className={styles.cameraGuide} aria-hidden>
          <div className={styles.cameraFrame} />
        </div>
      )}

      <div className={styles.cameraTop}>
        <button type="button" className={styles.cameraClose} onClick={onClose} aria-label="Close the camera" disabled={preparing}>
          <X aria-hidden />
        </button>
        {state.kind === "live" && !message && <p className={styles.cameraHint}>Fit the receipt in the frame</p>}
        {message && (
          <p className={styles.cameraProblem} role="alert">
            {message}
          </p>
        )}
      </div>

      {(state.kind === "starting" || preparing) && (
        <p className={`${styles.cameraStatus} ${preparing ? styles.cameraStatusOver : ""}`} role="status">
          <span className={styles.spinner} aria-hidden />
          {preparing ? "Getting the photo ready…" : "Opening the camera…"}
        </p>
      )}

      {state.kind === "unavailable" && !preparing && (
        <div className={styles.cameraFallback} role="alert">
          <p>{state.why}</p>
          <label className={styles.primary}>
            <Camera aria-hidden />
            <span>Use the phone’s camera</span>
            <input type="file" accept="image/*" capture="environment" className={styles.fileInput} onChange={chooseFile} />
          </label>
          {photos(styles.secondary, "Choose from phone")}
        </div>
      )}

      {state.kind === "live" && (
        <div className={styles.cameraBottom}>
          {photos(styles.cameraPhotos, "Photos")}
          <button type="button" className={styles.shutter} onClick={take} disabled={taking || preparing} aria-label="Take the photo">
            <span className={styles.shutterInner} aria-hidden />
          </button>
          <span className={styles.cameraBalance} aria-hidden />
        </div>
      )}
    </div>
  );
}
