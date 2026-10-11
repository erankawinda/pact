// Originals never leave this device. Header checks bound decode work; the server
// independently checks and re-encodes the small JPEG before storing it.
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 64_000_000;
export const MAX_SOURCE_EDGE = 12_000;
export const MAX_PHOTO_BYTES = 256 * 1024;
export type PhotoInfo = {format: 'jpeg'|'png'|'webp'|'heif'; width: number; height: number};
const invalid = () => new Error('This photo could not be read. Choose a JPEG, PNG, WebP or supported HEIC photo.');
const animated = () => new Error('Choose a still photo. Animated images are not supported.');
function dimensions(format: PhotoInfo['format'], width: number, height: number): PhotoInfo {
  if (!width || !height) throw invalid();
  if (width > MAX_SOURCE_EDGE || height > MAX_SOURCE_EDGE || width * height > MAX_SOURCE_PIXELS) {
    throw new Error('Choose a photo up to 64 megapixels, with neither side larger than 12,000 pixels.');
  }
  return {format, width, height};
}

export function inspectPhoto(bytes: Uint8Array): PhotoInfo {
  if (!bytes.length) throw invalid();
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Choose a photo smaller than 25 MiB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));
  const u16 = (at: number) => view.getUint16(at);
  const u32 = (at: number) => view.getUint32(at);
  const le32 = (at: number) => view.getUint32(at, true);
  const le24 = (at: number) => bytes[at] | bytes[at+1] << 8 | bytes[at+2] << 16;
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at < bytes.length) {
      if (bytes[at++] !== 0xff) throw invalid();
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) throw invalid();
      const size = u16(at);
      if (size < 2 || at + size > bytes.length) throw invalid();
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (size < 8 || size !== 8 + 3 * bytes[at+7]) throw invalid();
        return dimensions('jpeg', u16(at+5), u16(at+3));
      }
      at += size;
    }
    throw invalid();
  }
  if (bytes.length >= 33 && text(0,8) === '\x89PNG\r\n\x1a\n') {
    if (u32(8) !== 13 || text(12,4) !== 'IHDR') throw invalid();
    const info = dimensions('png', u32(16), u32(20));
    let at = 8, ended = false, data = false;
    while (at + 12 <= bytes.length) {
      const size = u32(at), type = text(at+4,4);
      if (at + 12 + size > bytes.length) throw invalid();
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw animated();
      if (type === 'IDAT') data = true;
      at += size + 12;
      if (type === 'IEND') { ended = true; break; }
    }
    if (!data || !ended || at !== bytes.length) throw invalid();
    return info;
  }
  if (bytes.length >= 20 && text(0,4) === 'RIFF' && text(8,4) === 'WEBP') {
    if (le32(4) + 8 !== bytes.length) throw invalid();
    let at = 12, info: PhotoInfo|undefined;
    while (at + 8 <= bytes.length) {
      const type = text(at,4), size = le32(at+4), start = at+8;
      if (start+size > bytes.length) throw invalid();
      if (type === 'ANIM' || type === 'ANMF') throw animated();
      if (type === 'VP8X') {
        if (size !== 10) throw invalid();
        if (bytes[start] & 2) throw animated();
        info = dimensions('webp', le24(start+4)+1, le24(start+7)+1);
      } else if (type === 'VP8 ') {
        if (size < 10 || text(start+3,3) !== '\x9d\x01\x2a') throw invalid();
        const frame = dimensions('webp', view.getUint16(start+6,true)&0x3fff, view.getUint16(start+8,true)&0x3fff);
        info ??= frame;
      } else if (type === 'VP8L') {
        if (size < 5 || bytes[start] !== 0x2f) throw invalid();
        const frame = dimensions('webp', 1 + (bytes[start+1] | (bytes[start+2]&0x3f)<<8), 1 + (bytes[start+2]>>6 | bytes[start+3]<<2 | (bytes[start+4]&0x0f)<<10));
        info ??= frame;
      }
      at = start+size+(size%2);
    }
    if (!info || at !== bytes.length) throw invalid();
    return info;
  }
  // HEIF uses bounded ISO BMFF boxes. Inspect every image property (including
  // thumbnails/tiles); native decoding still validates the actual output size.
  if (bytes.length >= 20 && text(4,4) === 'ftyp') {
    const ftypSize = u32(0);
    if (ftypSize < 16 || ftypSize > bytes.length || ftypSize % 4) throw invalid();
    const brands = [text(8,4)];
    for (let at = 16; at < ftypSize; at += 4) brands.push(text(at,4));
    if (!brands.some(value => ['heic','heix','mif1'].includes(value)) || brands.some(value => ['hevc','hevx','msf1','avis'].includes(value))) throw invalid();
    let info: PhotoInfo|undefined, boxes = 0;
    function walk(start: number, end: number, depth: number) {
      if (depth > 6) throw invalid();
      let at = start;
      while (at < end) {
        if (++boxes > 4096 || at+8 > end) throw invalid();
        const raw = u32(at), type = text(at+4,4);
        let size = raw, header = 8;
        if (raw === 1) {
          if (at+16 > end || u32(at+8) !== 0) throw invalid();
          size = u32(at+12); header = 16;
        } else if (raw === 0) size = end-at;
        if (size < header || at+size > end) throw invalid();
        const body = at+header;
        if (type === 'ispe') {
          if (size !== header+12) throw invalid();
          const next = dimensions('heif', u32(body+4), u32(body+8));
          if (!info || next.width*next.height > info.width*info.height) info = next;
        } else if (['meta','iprp','ipco'].includes(type)) {
          if (type === 'meta' && body+4 > at+size) throw invalid();
          walk(body+(type==='meta'?4:0), at+size, depth+1);
        }
        at += size;
      }
    }
    walk(ftypSize, bytes.length, 0);
    if (info) return info;
  }
  throw invalid();
}

export async function prepareProfilePhoto(file: File): Promise<Blob> {
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Choose a photo smaller than 25 MiB.');
  const info = inspectPhoto(new Uint8Array(await file.arrayBuffer()));
  const source = new Blob([file], {type: ({jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heif:'image/heic'})[info.format]});
  let bitmap: ImageBitmap|undefined, image: HTMLImageElement|undefined, objectUrl = '';
  const canvas = document.createElement('canvas');
  try {
    try { bitmap = await createImageBitmap(source, {imageOrientation:'from-image'}); }
    catch {
      // Safari can decode HEIC in an image element on supported OS versions.
      objectUrl = URL.createObjectURL(source);
      image = new Image(); image.src = objectUrl;
      await image.decode();
    }
    const width = bitmap?.width ?? image!.naturalWidth, height = bitmap?.height ?? image!.naturalHeight;
    dimensions(info.format, width, height);
    const edge = Math.min(512, width, height), crop = Math.min(width,height);
    canvas.width = edge; canvas.height = edge;
    const context = canvas.getContext('2d', {alpha:false});
    if (!context) throw new Error('Your browser could not prepare this photo.');
    context.fillStyle = '#ffffff'; context.fillRect(0,0,edge,edge);
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap ?? image!, (width-crop)/2, (height-crop)/2, crop,crop,0,0,edge,edge);
    for (const quality of [.86,.76,.64,.50]) {
      const result = await new Promise<Blob|null>(resolve => canvas.toBlob(resolve,'image/jpeg',quality));
      if (result?.type === 'image/jpeg' && result.size <= MAX_PHOTO_BYTES) return result;
    }
    throw new Error('This photo could not be reduced enough. Choose a simpler or smaller photo.');
  } catch (error) {
    if (error instanceof Error && /Choose|could not/.test(error.message)) throw error;
    throw new Error(info.format === 'heif' ? 'This browser cannot open this HEIC photo. Export it as JPEG, then choose that copy.' : 'This photo could not be decoded. Choose another photo.');
  } finally {
    bitmap?.close(); if (image) image.src = ''; if (objectUrl) URL.revokeObjectURL(objectUrl);
    canvas.width = 0; canvas.height = 0;
  }
}
