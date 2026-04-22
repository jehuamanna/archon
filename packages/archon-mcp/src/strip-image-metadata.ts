/**
 * Strip EXIF / text metadata from image bytes before handing them to an MCP client.
 *
 * PLAN-05 policy: inline + base64 + thumbnail modes return bytes, so those bytes
 * should not leak camera GPS / device info / user-authored comments. The `url`
 * mode is exempt (R2 streams raw bytes through a signed URL — nothing we can do).
 *
 * Best-effort by format. If the input looks malformed or the format is unknown,
 * return the original bytes unchanged — we never want to corrupt a decodable
 * image while trying to sanitize it.
 *
 * Covered:
 *   - JPEG: drop APP1 "Exif\0\0" segment; keep APP0 JFIF and everything else.
 *   - PNG:  drop eXIf, tEXt, zTXt, iTXt chunks (rare carriers of EXIF + author strings).
 *   - WebP: drop EXIF + XMP chunks and clear the VP8X has-EXIF / has-XMP flag bits.
 *   - GIF / unknown: pass through — GIF has no standard EXIF slot.
 */
export function stripImageMetadata(
  bytes: Uint8Array,
  mimeType: string,
): Uint8Array {
  const mt = mimeType.toLowerCase().trim();
  try {
    if (mt === "image/jpeg" || mt === "image/jpg") return stripJpeg(bytes);
    if (mt === "image/png") return stripPng(bytes);
    if (mt === "image/webp") return stripWebp(bytes);
  } catch {
    // Defensive: any parser surprise → return original.
    return bytes;
  }
  return bytes;
}

// ────────────────────────────────────────────────────────────────────────────
// JPEG — marker-walk up to SOS, drop APP1 Exif, copy the entropy stream verbatim.
// ────────────────────────────────────────────────────────────────────────────

function stripJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;

  const out: number[] = [0xff, 0xd8];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return bytes; // unexpected — bail conservatively
    // Skip fill bytes (0xFF 0xFF ... is legal between segments).
    let marker = bytes[i + 1];
    let markerOffset = i + 1;
    while (marker === 0xff && markerOffset + 1 < bytes.length) {
      markerOffset += 1;
      marker = bytes[markerOffset];
    }
    if (marker === undefined) return bytes;

    // Standalone markers (no length field): SOI (D8), EOI (D9), RSTn (D0-D7), TEM (01).
    if (marker === 0xd9) {
      out.push(0xff, 0xd9);
      return Uint8Array.from(out);
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(0xff, marker);
      i = markerOffset + 1;
      continue;
    }

    // SOS starts the entropy-coded stream; copy from here to EOI (or end) verbatim.
    if (marker === 0xda) {
      for (let k = i; k < bytes.length; k++) out.push(bytes[k]!);
      return Uint8Array.from(out);
    }

    const lenHi = bytes[markerOffset + 1];
    const lenLo = bytes[markerOffset + 2];
    if (lenHi === undefined || lenLo === undefined) return bytes;
    const segLen = (lenHi << 8) | lenLo; // includes the 2 length bytes
    const segStart = markerOffset + 1;
    const segEnd = segStart + segLen;
    if (segLen < 2 || segEnd > bytes.length) return bytes;

    const isExifApp1 =
      marker === 0xe1 &&
      segLen >= 8 &&
      bytes[segStart + 2] === 0x45 && // 'E'
      bytes[segStart + 3] === 0x78 && // 'x'
      bytes[segStart + 4] === 0x69 && // 'i'
      bytes[segStart + 5] === 0x66 && // 'f'
      bytes[segStart + 6] === 0x00 &&
      bytes[segStart + 7] === 0x00;

    if (!isExifApp1) {
      out.push(0xff, marker);
      for (let k = segStart; k < segEnd; k++) out.push(bytes[k]!);
    }

    i = segEnd;
  }
  return Uint8Array.from(out);
}

// ────────────────────────────────────────────────────────────────────────────
// PNG — chunk walk, drop textual / EXIF ancillaries.
// ────────────────────────────────────────────────────────────────────────────

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_STRIP_TYPES = new Set(["eXIf", "tEXt", "zTXt", "iTXt"]);

function stripPng(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 8) return bytes;
  for (let k = 0; k < 8; k++) {
    if (bytes[k] !== PNG_SIG[k]) return bytes;
  }

  const out: number[] = [];
  for (let k = 0; k < 8; k++) out.push(bytes[k]!);

  let i = 8;
  while (i + 8 <= bytes.length) {
    const dataLen =
      (bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (dataLen < 0) return bytes;
    const typeStart = i + 4;
    const type = String.fromCharCode(
      bytes[typeStart]!,
      bytes[typeStart + 1]!,
      bytes[typeStart + 2]!,
      bytes[typeStart + 3]!,
    );
    const chunkEnd = typeStart + 4 + dataLen + 4; // data + CRC
    if (chunkEnd > bytes.length) return bytes;

    if (!PNG_STRIP_TYPES.has(type)) {
      for (let k = i; k < chunkEnd; k++) out.push(bytes[k]!);
    }
    i = chunkEnd;
    if (type === "IEND") break;
  }
  return Uint8Array.from(out);
}

// ────────────────────────────────────────────────────────────────────────────
// WebP — RIFF container; drop EXIF + XMP chunks and clear VP8X flag bits.
// ────────────────────────────────────────────────────────────────────────────

function stripWebp(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12) return bytes;
  if (
    bytes[0] !== 0x52 || // 'R'
    bytes[1] !== 0x49 || // 'I'
    bytes[2] !== 0x46 || // 'F'
    bytes[3] !== 0x46 || // 'F'
    bytes[8] !== 0x57 || // 'W'
    bytes[9] !== 0x45 || // 'E'
    bytes[10] !== 0x42 || // 'B'
    bytes[11] !== 0x50 // 'P'
  ) {
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let i = 12;
  while (i + 8 <= bytes.length) {
    const type = String.fromCharCode(
      bytes[i]!,
      bytes[i + 1]!,
      bytes[i + 2]!,
      bytes[i + 3]!,
    );
    const dataLen =
      bytes[i + 4]! |
      (bytes[i + 5]! << 8) |
      (bytes[i + 6]! << 16) |
      (bytes[i + 7]! << 24);
    const padded = dataLen + (dataLen & 1); // chunks are word-aligned
    const chunkEnd = i + 8 + padded;
    if (dataLen < 0 || chunkEnd > bytes.length) return bytes;

    if (type === "EXIF" || type === "XMP ") {
      // skip
    } else if (type === "VP8X") {
      // Clear EXIF (bit 3) + XMP (bit 2) flags in the first byte.
      const copy = bytes.slice(i, chunkEnd);
      if (copy.length >= 9) {
        copy[8] = copy[8]! & ~((1 << 3) | (1 << 2));
      }
      chunks.push(copy);
    } else {
      chunks.push(bytes.slice(i, chunkEnd));
    }
    i = chunkEnd;
  }

  const totalChunkBytes = chunks.reduce((s, c) => s + c.length, 0);
  const newRiffSize = 4 + totalChunkBytes; // "WEBP" fourCC + chunks
  const out = new Uint8Array(8 + newRiffSize);
  out[0] = 0x52;
  out[1] = 0x49;
  out[2] = 0x46;
  out[3] = 0x46;
  out[4] = newRiffSize & 0xff;
  out[5] = (newRiffSize >>> 8) & 0xff;
  out[6] = (newRiffSize >>> 16) & 0xff;
  out[7] = (newRiffSize >>> 24) & 0xff;
  out[8] = 0x57;
  out[9] = 0x45;
  out[10] = 0x42;
  out[11] = 0x50;
  let w = 12;
  for (const c of chunks) {
    out.set(c, w);
    w += c.length;
  }
  return out;
}
