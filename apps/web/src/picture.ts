/**
 * Make a profile picture in the browser (M67, ADR 0061): the centre square of
 * whatever image the person picked, 256 × 256, re-encoded. Re-encoding through
 * a canvas drops everything a camera writes into a photo, where it was taken
 * included, and turns any format the browser can show (HEIC on a Mac, a GIF)
 * into one the server accepts.
 */

export const PICTURE_SIZE = 256;
const MAX_BYTES = 512 * 1024;

export class PictureError extends Error {}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function squarePicture(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    // from-image: honour a phone photo's rotation before cropping.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new PictureError('That file is not an image this browser can open.');
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = PICTURE_SIZE;
  canvas.height = PICTURE_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PictureError('This browser cannot prepare the picture.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, PICTURE_SIZE, PICTURE_SIZE);
  bitmap.close();

  // WebP where the browser can write it (it returns PNG when it cannot), smaller qualities if needed.
  for (const quality of [0.9, 0.8, 0.65]) {
    const blob = await encode(canvas, 'image/webp', quality);
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  const jpeg = await encode(canvas, 'image/jpeg', 0.85);
  if (jpeg && jpeg.size <= MAX_BYTES) return jpeg;
  throw new PictureError('That picture is too large, even made small.');
}
