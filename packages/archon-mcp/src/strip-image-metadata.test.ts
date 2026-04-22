import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripImageMetadata } from "./strip-image-metadata.js";

// ────────────────────────────────────────────────────────────────────────────
// JPEG fixture helpers
// ────────────────────────────────────────────────────────────────────────────

function jpegSegment(marker: number, payload: number[]): number[] {
  const len = payload.length + 2; // length field includes itself
  return [0xff, marker, (len >>> 8) & 0xff, len & 0xff, ...payload];
}

function jpegApp1Exif(payloadAfterHeader: number[] = [0x00]): number[] {
  // "Exif\0\0" + body
  return jpegSegment(0xe1, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...payloadAfterHeader]);
}

function jpegApp0Jfif(): number[] {
  // "JFIF\0" + version + aspect ratio
  return jpegSegment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
}

function jpegMinimal(segments: number[][]): Uint8Array {
  const out: number[] = [0xff, 0xd8]; // SOI
  for (const s of segments) out.push(...s);
  // SOS + tiny entropy stream + EOI
  out.push(...jpegSegment(0xda, [0x01, 0x00, 0x00]));
  out.push(0x55, 0xaa, 0x77);
  out.push(0xff, 0xd9);
  return Uint8Array.from(out);
}

// ────────────────────────────────────────────────────────────────────────────
// PNG fixture helpers
// ────────────────────────────────────────────────────────────────────────────

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngChunk(type: string, data: number[]): number[] {
  const len = data.length;
  const out = [
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
    ...data,
    0x00, 0x00, 0x00, 0x00, // fake CRC — stripping does not validate
  ];
  return out;
}

function pngMinimal(chunks: number[][]): Uint8Array {
  const out: number[] = [...PNG_SIG];
  // IHDR (13 bytes of data)
  out.push(
    ...pngChunk("IHDR", [
      0, 0, 0, 1, // width
      0, 0, 0, 1, // height
      8, 0, 0, 0, 0, // bit-depth / color / ...
    ]),
  );
  for (const c of chunks) out.push(...c);
  out.push(...pngChunk("IEND", []));
  return Uint8Array.from(out);
}

// ────────────────────────────────────────────────────────────────────────────
// WebP fixture helpers
// ────────────────────────────────────────────────────────────────────────────

function webpChunk(type: string, data: number[]): number[] {
  const len = data.length;
  const padded = len + (len & 1);
  const chunk = [
    type.charCodeAt(0),
    type.charCodeAt(1),
    type.charCodeAt(2),
    type.charCodeAt(3),
    len & 0xff,
    (len >>> 8) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 24) & 0xff,
    ...data,
  ];
  if (padded !== len) chunk.push(0x00);
  return chunk;
}

function webpContainer(chunks: number[][]): Uint8Array {
  const body: number[] = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
  for (const c of chunks) body.push(...c);
  const size = body.length;
  const out = [
    0x52, 0x49, 0x46, 0x46, // "RIFF"
    size & 0xff,
    (size >>> 8) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 24) & 0xff,
    ...body,
  ];
  return Uint8Array.from(out);
}

function includesSubSeq(haystack: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe("stripImageMetadata", () => {
  it("drops JPEG APP1 Exif segment, keeps APP0 JFIF and entropy stream", () => {
    const secret = [0x53, 0x45, 0x43, 0x52, 0x45, 0x54]; // "SECRET"
    const input = jpegMinimal([jpegApp0Jfif(), jpegApp1Exif(secret)]);
    const out = stripImageMetadata(input, "image/jpeg");

    assert.equal(out[0], 0xff);
    assert.equal(out[1], 0xd8); // SOI preserved
    // JFIF marker (0xFF 0xE0) still present
    assert.ok(includesSubSeq(out, [0xff, 0xe0]));
    // APP1 marker (0xFF 0xE1) gone
    assert.ok(!includesSubSeq(out, [0xff, 0xe1]));
    // "Exif\0\0" fingerprint gone
    assert.ok(!includesSubSeq(out, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]));
    // Secret payload gone
    assert.ok(!includesSubSeq(out, secret));
    // EOI intact
    assert.equal(out[out.length - 2], 0xff);
    assert.equal(out[out.length - 1], 0xd9);
    // Output strictly smaller than input
    assert.ok(out.length < input.length);
  });

  it("leaves JPEG unchanged when there is no APP1 Exif", () => {
    const input = jpegMinimal([jpegApp0Jfif()]);
    const out = stripImageMetadata(input, "image/jpeg");
    assert.deepEqual(Array.from(out), Array.from(input));
  });

  it("passes through non-JPEG-shaped bytes on image/jpeg", () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    const out = stripImageMetadata(garbage, "image/jpeg");
    assert.deepEqual(Array.from(out), Array.from(garbage));
  });

  it("drops PNG eXIf, tEXt, zTXt, iTXt chunks; keeps IHDR/IDAT/IEND", () => {
    const idat = pngChunk("IDAT", [0x78, 0x9c, 0x63, 0x00, 0x00]);
    const exif = pngChunk("eXIf", [0x4d, 0x4d, 0x00, 0x2a, 0xde, 0xad, 0xbe, 0xef]);
    const text = pngChunk("tEXt", [0x43, 0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74, 0x00, 0x68, 0x69]);
    const input = pngMinimal([exif, idat, text]);
    const out = stripImageMetadata(input, "image/png");

    // IHDR + IDAT + IEND retained
    assert.ok(includesSubSeq(out, [0x49, 0x48, 0x44, 0x52])); // "IHDR"
    assert.ok(includesSubSeq(out, [0x49, 0x44, 0x41, 0x54])); // "IDAT"
    assert.ok(includesSubSeq(out, [0x49, 0x45, 0x4e, 0x44])); // "IEND"
    // Stripped chunk types absent
    assert.ok(!includesSubSeq(out, [0x65, 0x58, 0x49, 0x66])); // "eXIf"
    assert.ok(!includesSubSeq(out, [0x74, 0x45, 0x58, 0x74])); // "tEXt"
    // Stripped payloads absent
    assert.ok(!includesSubSeq(out, [0xde, 0xad, 0xbe, 0xef]));
  });

  it("leaves PNG unchanged when no strippable chunks are present", () => {
    const idat = pngChunk("IDAT", [0x78, 0x9c, 0x00]);
    const input = pngMinimal([idat]);
    const out = stripImageMetadata(input, "image/png");
    assert.deepEqual(Array.from(out), Array.from(input));
  });

  it("drops WebP EXIF + XMP chunks and clears VP8X flag bits", () => {
    const vp8x = webpChunk("VP8X", [
      0b0000_1100, // EXIF (bit 3) + XMP (bit 2) present; caller will strip them
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
      0x00, 0x00, 0x00,
    ]);
    const vp8 = webpChunk("VP8 ", [0xaa, 0xbb, 0xcc, 0xdd]);
    const exif = webpChunk("EXIF", [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0xde, 0xad]);
    const xmp = webpChunk("XMP ", [0x3c, 0x78, 0x3a, 0x78, 0x6d, 0x70]);
    const input = webpContainer([vp8x, vp8, exif, xmp]);
    const out = stripImageMetadata(input, "image/webp");

    assert.ok(includesSubSeq(out, [0x56, 0x50, 0x38, 0x58])); // "VP8X"
    assert.ok(includesSubSeq(out, [0x56, 0x50, 0x38, 0x20])); // "VP8 "
    assert.ok(!includesSubSeq(out, [0x45, 0x58, 0x49, 0x46])); // "EXIF"
    assert.ok(!includesSubSeq(out, [0x58, 0x4d, 0x50, 0x20])); // "XMP "
    assert.ok(!includesSubSeq(out, [0xde, 0xad]));

    // VP8X flag byte cleared: find "VP8X" then its flag byte (at +8 from type start).
    const vp8xAt = out.indexOf(0x56);
    assert.notEqual(vp8xAt, -1);
    assert.equal(out[vp8xAt + 8], 0);

    // RIFF size reflects the stripped body.
    const riffSize =
      out[4]! | (out[5]! << 8) | (out[6]! << 16) | (out[7]! << 24);
    assert.equal(riffSize, out.length - 8);
  });

  it("passes through WebP without EXIF/XMP unchanged in substance", () => {
    const vp8 = webpChunk("VP8 ", [0x01, 0x02, 0x03, 0x04]);
    const input = webpContainer([vp8]);
    const out = stripImageMetadata(input, "image/webp");
    assert.deepEqual(Array.from(out), Array.from(input));
  });

  it("passes through GIF and unknown formats unchanged", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
    assert.deepEqual(
      Array.from(stripImageMetadata(gif, "image/gif")),
      Array.from(gif),
    );
    assert.deepEqual(
      Array.from(stripImageMetadata(gif, "application/octet-stream")),
      Array.from(gif),
    );
  });
});
