/**
 * A ZIP archive with every file stored as it is, not compressed — which is
 * all an .xlsx needs to be. Written here so the costs page takes on no
 * package: local headers, a central directory and its end record, with a
 * CRC-32 of each file.
 *
 * Client-safe, and pure: bytes in, bytes out.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 a ZIP header carries (the IEEE polynomial, reflected). */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipFile {
  /**
   * Path inside the archive, e.g. "xl/workbook.xml". A name beyond ASCII (a
   * property's name in the month ZIP, dispatch 24) is written in UTF-8 with
   * the ZIP's UTF-8 flag set, so every tool reads it as written; an ASCII
   * name is written exactly as before.
   */
  name: string;
  data: Uint8Array;
}

/** A moment as ZIP headers carry it: local time, in two-second steps, from 1980. */
function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/** The archive, files in the order given. */
export function zipStored(files: ZipFile[], modified: Date): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const { time, date } = dosDateTime(modified);
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    // General purpose bit 11: the name is UTF-8. Only set when it matters, so an ASCII-named archive is byte for byte as before.
    const flags = name.length === file.name.length ? 0 : 0x0800;
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); // local file header
    l.setUint16(4, 20, true); // version needed: 2.0
    l.setUint16(6, flags, true); // flags
    l.setUint16(8, 0, true); // method: stored
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, size, true); // compressed size
    l.setUint32(22, size, true); // uncompressed size
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true); // extra field length
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true); // central directory header
    c.setUint16(4, 20, true); // version made by
    c.setUint16(6, 20, true); // version needed
    c.setUint16(8, flags, true); // flags
    c.setUint16(10, 0, true); // method: stored
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, size, true);
    c.setUint32(24, size, true);
    c.setUint16(28, name.length, true);
    c.setUint16(30, 0, true); // extra field length
    c.setUint16(32, 0, true); // comment length
    c.setUint16(34, 0, true); // disk number
    c.setUint16(36, 0, true); // internal attributes
    c.setUint32(38, 0, true); // external attributes
    c.setUint32(42, offset, true); // where its local header starts
    central.set(name, 46);

    parts.push(local, file.data);
    directory.push(central);
    offset += local.length + size;
  }

  const directorySize = directory.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); // end of central directory
  e.setUint16(4, 0, true); // this disk
  e.setUint16(6, 0, true); // disk where the directory starts
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);
  e.setUint16(20, 0, true); // comment length

  const out = new Uint8Array(offset + directorySize + end.length);
  let at = 0;
  for (const part of [...parts, ...directory, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
