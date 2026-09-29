/**
 * A receipt photo, shrunk on the phone before it is sent.
 *
 * A phone camera takes 12 megapixels or more, and several megabytes, which a
 * hallway's signal is slow to send and the server does not need. The photo is
 * redrawn at most 4 megapixels (and 4096 px on the long edge, inside every
 * phone's canvas limit), then saved as a JPEG at quality 0.82. If that is
 * still 4 MiB or more, it steps down — quality 0.72, then 0.62, then 15%
 * smaller each time — until it is under 4 MiB, the server's limit per
 * receipt. A pixel budget rather than a width keeps a long receipt legible.
 *
 * Redrawing also drops the photo's metadata (EXIF, location included) and
 * turns HEIC or PNG into JPEG. The photo is decoded through an <img>, which
 * applies the camera's orientation, so a receipt shot upright stays upright.
 * A photo the browser cannot decode — HEIC outside Safari — is refused with a
 * reason the screen can explain.
 *
 * Client-only.
 */

import { LIMITS } from '@/app/lib/cleaners/model';

/** At most 4 megapixels. */
const MAX_PIXELS = 4_000_000;
/** And at most this on the long edge. */
const MAX_EDGE = 4096;
const QUALITIES = [0.82, 0.72, 0.62] as const;
/** Each further step makes the photo this much smaller along each edge. */
const SHRINK_STEP = 0.85;
const MAX_SHRINK_STEPS = 12;

export interface PreparedPhoto {
  blob: Blob;
  width: number;
  height: number;
  /** The original's file name as a .jpg, sent as the upload's name. */
  name: string;
}

export type PhotoProblem = 'unreadable' | 'too-large';

export class PhotoError extends Error {
  constructor(readonly problem: PhotoProblem) {
    super(problem === 'unreadable' ? 'The photo could not be read' : 'The photo could not be made small enough');
    this.name = 'PhotoError';
  }
}

/** The file name to send: the original's, with a .jpg extension. */
function jpegName(original: string): string {
  const base = original.replace(/\.[^.]*$/, '').trim();
  return `${base || 'receipt'}.jpg`;
}

async function decode(file: Blob): Promise<{ image: HTMLImageElement; release: () => void }> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = 'async';
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new PhotoError('unreadable');
  }
  if (image.naturalWidth === 0 || image.naturalHeight === 0) {
    URL.revokeObjectURL(url);
    throw new PhotoError('unreadable');
  }
  return { image, release: () => URL.revokeObjectURL(url) };
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new PhotoError('unreadable'))),
      'image/jpeg',
      quality,
    );
  });
}

/** Shrink one photo for sending. @throws PhotoError */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const { image, release } = await decode(file);
  const canvas = document.createElement('canvas');
  try {
    const width0 = image.naturalWidth;
    const height0 = image.naturalHeight;
    let scale = Math.min(
      1,
      Math.sqrt(MAX_PIXELS / (width0 * height0)),
      MAX_EDGE / Math.max(width0, height0),
    );

    for (let step = 0; step <= MAX_SHRINK_STEPS; step++) {
      const width = Math.max(1, Math.floor(width0 * scale));
      const height = Math.max(1, Math.floor(height0 * scale));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new PhotoError('unreadable');
      // A transparent PNG would turn black as a JPEG: paper is white.
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, width, height);

      // Full size: every quality in turn. Smaller: the lowest only.
      for (const quality of step === 0 ? QUALITIES : QUALITIES.slice(-1)) {
        const blob = await toJpeg(canvas, quality);
        if (blob.size < LIMITS.RECEIPT_MAX_BYTES) {
          return { blob, width, height, name: jpegName(file.name) };
        }
      }
      scale *= SHRINK_STEP;
    }
    throw new PhotoError('too-large');
  } finally {
    // Let the phone have its memory back: a 4 MP canvas is 16 MB.
    canvas.width = 0;
    canvas.height = 0;
    release();
  }
}
