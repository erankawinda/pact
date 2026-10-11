import jpeg from 'jpeg-js';

export const MAX_PHOTO_BYTES = 256 * 1024;
export const MAX_PHOTO_EDGE = 512;
export class PhotoError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}

/** Check dimensions before allocating decoded pixels. Browser canvas emits baseline JPEG. */
export function jpegDimensions(bytes: Uint8Array): {width: number; height: number} {
  const invalid = () => new PhotoError('photo_invalid_image', 'Choose a photo and prepare it again.');
  if (bytes.length < 4 || bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw invalid();
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 0xff) throw invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) throw invalid();
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw invalid();
    const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (frame) {
      // Restrict the server to the small, baseline raster the client prepares.
      if (marker !== 0xc0 || length < 8 || bytes[offset + 2] !== 8 || ![1, 3].includes(bytes[offset + 7])) throw invalid();
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      if (!width || !height || width > MAX_PHOTO_EDGE || height > MAX_PHOTO_EDGE) {
        throw new PhotoError('photo_dimensions', 'The prepared photo must be no larger than 512 × 512 pixels.');
      }
      return {width, height};
    }
    offset += length;
  }
  throw invalid();
}

/** Decode untrusted bytes, then encode pixels alone so EXIF, GPS, comments and other metadata are discarded. */
export function sanitizePhoto(bytes: Uint8Array): Uint8Array {
  const expected = jpegDimensions(bytes);
  try {
    const pixels = jpeg.decode(bytes, {useTArray: true, formatAsRGBA: true, tolerantDecoding: false, maxResolutionInMP: .262144, maxMemoryUsageInMB: 16});
    if (pixels.width !== expected.width || pixels.height !== expected.height || pixels.data.length !== expected.width * expected.height * 4) throw new Error('Dimension mismatch');
    for (const quality of [82, 70, 55]) {
      // Deliberately do not pass through decoder metadata such as exifBuffer.
      const encoded = jpeg.encode({width: pixels.width, height: pixels.height, data: pixels.data}, quality).data;
      if (encoded.length <= MAX_PHOTO_BYTES) return new Uint8Array(encoded);
    }
    throw new PhotoError('photo_too_large', 'The prepared photo is too large. Choose a simpler crop.');
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    throw new PhotoError('photo_invalid_image', 'This photo could not be decoded safely. Choose another image.');
  }
}

export async function readPhotoBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'image/jpeg') throw new PhotoError('photo_invalid_type', 'Upload the JPEG prepared by Pact.', 415);
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_PHOTO_BYTES)) throw new PhotoError('photo_too_large', 'The prepared photo must be 256 KiB or smaller.', 413);
  const reader = request.body?.getReader();
  if (!reader) throw new PhotoError('photo_invalid_image', 'Choose a photo first.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timer = setTimeout(() => void reader.cancel('Photo upload timed out'), 15_000);
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_PHOTO_BYTES) {
        await reader.cancel();
        throw new PhotoError('photo_too_large', 'The prepared photo must be 256 KiB or smaller.', 413);
      }
      chunks.push(value);
    }
  } finally { clearTimeout(timer); reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}
