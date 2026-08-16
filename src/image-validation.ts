function u16be(bytes: Uint8Array, offset: number) {
  return bytes[offset]! * 0x100 + bytes[offset + 1]!;
}

function u16le(bytes: Uint8Array, offset: number) {
  return bytes[offset]! + bytes[offset + 1]! * 0x100;
}

function u24le(bytes: Uint8Array, offset: number) {
  return bytes[offset]! + bytes[offset + 1]! * 0x100 + bytes[offset + 2]! * 0x10000;
}

function u32be(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function u32le(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function saneDimensions(width: number, height: number) {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= 100_000 &&
    height <= 100_000 &&
    width * height <= 268_435_456
  );
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(bytes: Uint8Array) {
  if (
    bytes.length < 45 ||
    ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    )
  ) {
    return false;
  }
  let offset = 8;
  let first = true;
  let sawImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = u32be(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const crcOffset = dataOffset + length;
    if (length > bytes.length - dataOffset - 4) return false;
    const type = ascii(bytes, typeOffset, 4);
    if (!/^[A-Za-z]{4}$/u.test(type)) return false;
    if (u32be(bytes, crcOffset) !== crc32(bytes.subarray(typeOffset, crcOffset))) return false;
    if (first) {
      if (type !== "IHDR" || length !== 13) return false;
      if (!saneDimensions(u32be(bytes, dataOffset), u32be(bytes, dataOffset + 4))) return false;
      first = false;
    } else if (type === "IHDR") {
      return false;
    }
    if (type === "IDAT" && length > 0) sawImageData = true;
    offset = crcOffset + 4;
    if (type === "IEND") return length === 0 && sawImageData && offset === bytes.length;
  }
  return false;
}

const JPEG_START_OF_FRAME = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function validJpeg(bytes: Uint8Array) {
  if (bytes.length < 20 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let sawEntropyData = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return false;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return false;
    const marker = bytes[offset++]!;
    if (marker === 0xd9) {
      return sawFrame && sawScan && sawEntropyData && offset === bytes.length;
    }
    if (marker === 0xd8 || marker === 0x00) return false;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return false;
    const length = u16be(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return false;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (length < 8 || !saneDimensions(u16be(bytes, offset + 3), u16be(bytes, offset + 5))) {
        return false;
      }
      sawFrame = true;
    }
    if (marker === 0xda) {
      if (!sawFrame || length < 6) return false;
      sawScan = true;
      offset += length;
      let scanEntropyData = false;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          scanEntropyData = true;
          sawEntropyData = true;
          offset += 1;
          continue;
        }
        if (offset + 1 >= bytes.length) return false;
        const next = bytes[offset + 1]!;
        if (next === 0x00) {
          scanEntropyData = true;
          sawEntropyData = true;
          offset += 2;
          continue;
        }
        if (next >= 0xd0 && next <= 0xd7) {
          offset += 2;
          continue;
        }
        if (!scanEntropyData) return false;
        // A progressive JPEG can interleave multiple SOS segments with tables
        // and other markers. Leave the terminating marker for the outer loop.
        break;
      }
      continue;
    }
    offset += length;
  }
  return false;
}

function skipGifSubBlocks(bytes: Uint8Array, initialOffset: number) {
  let offset = initialOffset;
  let payloadBytes = 0;
  while (offset < bytes.length) {
    const size = bytes[offset++]!;
    if (size === 0) return { offset, payloadBytes };
    if (offset + size > bytes.length) return undefined;
    payloadBytes += size;
    offset += size;
  }
  return undefined;
}

function validGif(bytes: Uint8Array) {
  if (bytes.length < 14 || !["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return false;
  if (!saneDimensions(u16le(bytes, 6), u16le(bytes, 8))) return false;
  let offset = 13;
  if (bytes[10]! & 0x80) offset += 3 * (1 << ((bytes[10]! & 0x07) + 1));
  if (offset > bytes.length) return false;
  let sawImage = false;
  while (offset < bytes.length) {
    const introducer = bytes[offset++]!;
    if (introducer === 0x3b) return sawImage && offset === bytes.length;
    if (introducer === 0x21) {
      if (offset >= bytes.length) return false;
      offset += 1;
      const extension = skipGifSubBlocks(bytes, offset);
      if (!extension) return false;
      offset = extension.offset;
      continue;
    }
    if (introducer !== 0x2c || offset + 9 > bytes.length) return false;
    const width = u16le(bytes, offset + 4);
    const height = u16le(bytes, offset + 6);
    if (!saneDimensions(width, height)) return false;
    const packed = bytes[offset + 8]!;
    offset += 9;
    if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));
    if (offset >= bytes.length) return false;
    const lzwMinimumCodeSize = bytes[offset++]!;
    if (lzwMinimumCodeSize < 2 || lzwMinimumCodeSize > 8) return false;
    const imageData = skipGifSubBlocks(bytes, offset);
    if (!imageData || imageData.payloadBytes === 0) return false;
    offset = imageData.offset;
    sawImage = true;
  }
  return false;
}

function validVp8Chunk(bytes: Uint8Array, data: number, length: number) {
  return (
    length > 10 &&
    bytes[data + 3] === 0x9d &&
    bytes[data + 4] === 0x01 &&
    bytes[data + 5] === 0x2a &&
    saneDimensions(u16le(bytes, data + 6) & 0x3fff, u16le(bytes, data + 8) & 0x3fff)
  );
}

function validVp8lChunk(bytes: Uint8Array, data: number, length: number) {
  if (length <= 5 || bytes[data] !== 0x2f) return false;
  const bits = u32le(bytes, data + 1);
  return saneDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
}

function validAnimatedWebpFrame(bytes: Uint8Array, data: number, length: number) {
  if (
    length < 25 ||
    !saneDimensions(u24le(bytes, data + 6) + 1, u24le(bytes, data + 9) + 1)
  ) {
    return false;
  }
  let offset = data + 16;
  const end = data + length;
  let sawImage = false;
  while (offset + 8 <= end) {
    const type = ascii(bytes, offset, 4);
    const chunkLength = u32le(bytes, offset + 4);
    const chunkData = offset + 8;
    const chunkEnd = chunkData + chunkLength + (chunkLength & 1);
    if (chunkLength > end - chunkData || chunkEnd > end) return false;
    if (type === "VP8 ") {
      if (!validVp8Chunk(bytes, chunkData, chunkLength)) return false;
      sawImage = true;
    } else if (type === "VP8L") {
      if (!validVp8lChunk(bytes, chunkData, chunkLength)) return false;
      sawImage = true;
    } else if (type !== "ALPH") {
      return false;
    }
    offset = chunkEnd;
  }
  return sawImage && offset === end;
}

function validWebp(bytes: Uint8Array) {
  if (
    bytes.length < 30 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP" ||
    u32le(bytes, 4) !== bytes.length - 8
  ) {
    return false;
  }
  let offset = 12;
  let sawImage = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = u32le(bytes, offset + 4);
    const data = offset + 8;
    if (length > bytes.length - data || data + length + (length & 1) > bytes.length) return false;
    if (type === "VP8 ") {
      if (!validVp8Chunk(bytes, data, length)) return false;
      sawImage = true;
    } else if (type === "VP8L") {
      if (!validVp8lChunk(bytes, data, length)) return false;
      sawImage = true;
    } else if (type === "VP8X") {
      if (length !== 10 || !saneDimensions(u24le(bytes, data + 4) + 1, u24le(bytes, data + 7) + 1)) {
        return false;
      }
    } else if (type === "ANMF") {
      if (!validAnimatedWebpFrame(bytes, data, length)) return false;
      sawImage = true;
    }
    offset = data + length + (length & 1);
  }
  return sawImage && offset === bytes.length;
}

const SIGNATURES: Record<string, (bytes: Uint8Array) => boolean> = {
  "image/png": validPng,
  "image/jpeg": validJpeg,
  "image/gif": validGif,
  "image/webp": validWebp,
};

const EXTENSIONS: Record<string, Set<string>> = {
  "image/png": new Set([".png"]),
  "image/jpeg": new Set([".jpg", ".jpeg"]),
  "image/gif": new Set([".gif"]),
  "image/webp": new Set([".webp"]),
};

export const MCP_IMAGE_MEDIA_TYPES = new Set(Object.keys(SIGNATURES));

export function assertMcpImageBytes(options: {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
}) {
  const mimeType = options.mimeType.toLocaleLowerCase("en-US");
  const extension = options.extension.toLocaleLowerCase("en-US");
  const validator = SIGNATURES[mimeType];
  if (!validator) throw new Error(`${options.mimeType} cannot be returned as an MCP image`);
  if (!EXTENSIONS[mimeType]?.has(extension)) {
    throw new Error(
      `preview extension ${options.extension || "missing"} does not match ${options.mimeType}`,
    );
  }
  if (!validator(options.bytes)) {
    throw new Error(`preview bytes do not have a valid ${options.mimeType} signature and structure`);
  }
}
