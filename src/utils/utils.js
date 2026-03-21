// ── Formatters ──────────────────────────────────────────────────────
export const fmt = (b) =>
  !b || b === 0 ? "0 B" :
  b < 1024 ? `${b} B` :
  b < 1048576 ? `${(b / 1024).toFixed(1)} KB` :
  b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` :
  `${(b / 1073741824).toFixed(2)} GB`;

export const fmtSpd = (b) =>
  !b || b <= 0 ? "—" :
  b < 1048576 ? `${(b / 1024).toFixed(1)} KB/s` :
  `${(b / 1048576).toFixed(1)} MB/s`;

export const fmtTime = (s) => {
  if (!s || !isFinite(s) || s <= 0) return "—";
  if (s < 60)   return `${Math.ceil(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.ceil(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export const fmtDate = (ts) =>
  new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const tsNow = () =>
  new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ── File helpers ────────────────────────────────────────────────────
export const fileIcon = (name = "") => {
  const ext = name.split(".").pop().toLowerCase();
  const m = {
    pdf: "📄", doc: "📝", docx: "📝", txt: "📃", md: "📃", rtf: "📝",
    jpg: "🖼️", jpeg: "🖼️", png: "🖼️", gif: "🖼️", webp: "🖼️", svg: "🖼️", bmp: "🖼️", ico: "🖼️",
    mp4: "🎬", mov: "🎬", avi: "🎬", mkv: "🎬", webm: "🎬", flv: "🎬",
    mp3: "🎵", wav: "🎵", flac: "🎵", ogg: "🎵", aac: "🎵", m4a: "🎵",
    zip: "📦", rar: "📦", "7z": "📦", tar: "📦", gz: "📦", bz2: "📦",
    js: "⚙️", ts: "⚙️", jsx: "⚙️", tsx: "⚙️", py: "🐍", go: "🐹",
    html: "🌐", css: "🎨", json: "📋", xml: "📋", yaml: "📋", yml: "📋",
    xls: "📊", xlsx: "📊", csv: "📊",
    ppt: "📑", pptx: "📑",
    exe: "💾", dmg: "💾", pkg: "💾", deb: "💾", apk: "📱", ipa: "📱",
    sh: "🖥️", bat: "🖥️", ps1: "🖥️",
    sql: "🗄️", db: "🗄️", sqlite: "🗄️",
  };
  return m[ext] || "📎";
};

export const isImage = (name = "") => /\.(jpe?g|png|gif|webp|svg|bmp)$/i.test(name);
export const isVideo = (name = "") => /\.(mp4|mov|avi|mkv|webm)$/i.test(name);
export const isAudio = (name = "") => /\.(mp3|wav|flac|ogg|aac|m4a)$/i.test(name);

// ── Avatar ──────────────────────────────────────────────────────────
const COLORS = [
  "#00e5ff", "#7c3aed", "#f59e0b", "#22c55e",
  "#f43f5e", "#3b82f6", "#a78bfa", "#fb923c",
  "#06b6d4", "#84cc16", "#ec4899", "#14b8a6",
];

export const avatarColor = (id = "") => {
  let h = 0;
  for (const c of id) h = ((h << 5) - h) + c.charCodeAt(0);
  return COLORS[Math.abs(h) % COLORS.length];
};

export const avatarInitial = (name = "") => name.trim()[0]?.toUpperCase() || "?";

// ── CRC32 checksum ──────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export const crc32 = (buf) => {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) :
                buf.buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) :
                new Uint8Array(buf);
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
};

// ── Compress (gzip via CompressionStream) ───────────────────────────
const TEXT_EXTS = /\.(txt|md|json|csv|js|ts|jsx|tsx|html|css|xml|py|java|c|cpp|rs|go|rb|php|sh|yaml|yml|svg|log)$/i;

export const tryCompress = async (file) => {
  if (!TEXT_EXTS.test(file.name)) return null;
  if (!window.CompressionStream) return null;
  try {
    const buf = await file.arrayBuffer();
    const cs  = new CompressionStream("gzip");
    const w   = cs.writable.getWriter();
    w.write(buf); w.close();
    const chunks = [];
    const reader = cs.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const blob = new Blob(chunks);
    return blob.size < file.size * 0.92 ? blob : null;
  } catch { return null; }
};

export const tryDecompress = async (chunks) => {
  if (!window.DecompressionStream) return null;
  try {
    const ds = new DecompressionStream("gzip");
    const w  = ds.writable.getWriter();
    for (const c of chunks) w.write(c instanceof ArrayBuffer ? c : c.buffer);
    w.close();
    const out = [];
    const r   = ds.readable.getReader();
    while (true) {
      const { done, value } = await r.read();
      if (done) break;
      out.push(value);
    }
    return out;
  } catch { return null; }
};

// ── Clipboard ───────────────────────────────────────────────────────
export const copyText = async (text) => {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
};

// ── Random ID ───────────────────────────────────────────────────────
export const uid = () => Math.random().toString(36).slice(2, 10);
