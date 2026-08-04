import fs from 'node:fs';

/**
 * 極簡 ZIP 打包器（只用 store 模式，不壓縮）。
 *
 * 照片都是 JPEG，已經壓過了，再走 deflate 只是多燒 CPU 換不到體積。
 * 用 store 就不必引進壓縮相依套件，也能一個檔案一個檔案寫出去，
 * 記憶體只需要撐得住單一檔案，不會把整包 ZIP 疊在記憶體裡。
 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

/** ZIP 沿用 MS-DOS 的時間格式：秒只到 2 秒精度，年從 1980 起算。 */
function dosDateTime(date) {
  const at = Number.isNaN(date?.getTime?.()) || !date ? new Date() : date;
  const year = Math.max(1980, at.getFullYear());
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

const UTF8_FLAG = 0x0800;   // 檔名有中文，一定要開這個位元

function localHeader(entry) {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034B50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(UTF8_FLAG, 6);
  head.writeUInt16LE(0, 8);                  // 0 = store
  head.writeUInt16LE(entry.time, 10);
  head.writeUInt16LE(entry.date, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.size, 18);
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(entry.name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, entry.name]);
}

function centralHeader(entry) {
  const head = Buffer.alloc(46);
  head.writeUInt32LE(0x02014B50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(20, 6);
  head.writeUInt16LE(UTF8_FLAG, 8);
  head.writeUInt16LE(0, 10);
  head.writeUInt16LE(entry.time, 12);
  head.writeUInt16LE(entry.date, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.size, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(entry.name.length, 28);
  head.writeUInt16LE(0, 30);                 // extra
  head.writeUInt16LE(0, 32);                 // comment
  head.writeUInt16LE(0, 34);                 // disk
  head.writeUInt16LE(0, 36);                 // internal attrs
  head.writeUInt32LE(0, 38);                 // external attrs
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, entry.name]);
}

function endOfCentralDirectory(entries, cdSize, cdOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054B50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries, 8);
  end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

/**
 * 把檔案逐一寫進 out（任何 Writable，例如 res）。
 * files: [{ path, name, date }]，name 是壓縮檔裡的路徑。
 */
export function writeZip(out, files) {
  const entries = [];
  let offset = 0;

  for (const file of files) {
    let data;
    try {
      data = fs.readFileSync(file.path);
    } catch (err) {
      console.error(`[zip] 略過讀不到的檔案 ${file.path}：`, err.message);
      continue;
    }
    const { time, date } = dosDateTime(file.date);
    const entry = {
      name: Buffer.from(file.name, 'utf8'),
      crc: crc32(data),
      size: data.length,
      time,
      date,
      offset,
    };
    const head = localHeader(entry);
    out.write(head);
    out.write(data);
    offset += head.length + data.length;
    entries.push(entry);
  }

  const central = entries.map(centralHeader);
  const cdSize = central.reduce((sum, buf) => sum + buf.length, 0);
  for (const buf of central) out.write(buf);
  out.write(endOfCentralDirectory(entries.length, cdSize, offset));
  out.end();
  return entries.length;
}
