// Turns an uploaded study file into something the AI can read.
//
// - .pptx  : we unzip the OOXML package in-process (no dependency) and pull the text runs out of
//            each slide, in slide order. (Legacy binary .ppt is not supported.)
// - .txt/.md/.csv : decoded as UTF-8 text.
// - PDF      : passed through to Gemini as an inline document (it reads PDFs natively).
// - images   : passed through to Gemini as inline image data (it reads them natively).
//
// Everything else is rejected with a friendly message.
const zlib = require("zlib");
const { HttpError } = require("./middleware/errors");

const TEXT_TYPES = new Set(["text/plain", "text/markdown", "text/csv"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"]);
const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PDF_TYPE = "application/pdf";

const MAX_TEXT_CHARS = 120000; // keeps the model request within a sane size

const extOf = (name = "") => (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [null, ""])[1];

/* ---------------- minimal ZIP reader (OOXML packages are zip archives) ---------------- */

// Locate the End Of Central Directory record by scanning backwards from the end.
function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// Read the central directory and return { name, method, compressedSize, localOffset } per entry.
function readZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new HttpError(400, "That PowerPoint file looks corrupted and couldn't be read.");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Decompress one entry. Sizes come from the central directory, so a missing local size (data
// descriptor) is not a problem — we only need the local header length to find where data starts.
function readZipEntry(buf, entry) {
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  try {
    return entry.method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
  } catch {
    return null;
  }
}

const decodeXml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// Pull every <a:t>…</a:t> (drawing text) and <w:t>…</w:t> (word text) run out of a slide's XML.
function textFromSlideXml(xml) {
  const runs = xml.match(/<(?:a|w):t(?:\s[^>]*)?>[\s\S]*?<\/(?:a|w):t>/g) || [];
  const text = runs.map((run) => decodeXml(run.replace(/<[^>]+>/g, ""))).join(" ").replace(/\s+/g, " ").trim();
  return text;
}

function extractPptx(buf) {
  const entries = readZipEntries(buf);
  const wanted = entries
    .map((entry) => {
      const m = entry.name.match(/^ppt\/slides\/slide(\d+)\.xml$/);
      return m ? { entry, n: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
  if (!wanted.length) throw new HttpError(400, "That PowerPoint file has no slides to read.");
  const slides = wanted.map(({ entry, n }) => {
    const xml = readZipEntry(buf, entry);
    const text = xml ? textFromSlideXml(xml.toString("utf8")) : "";
    const cleaned = text.replace(/^(?:slide\s*)?\d+\s+/i, "").replace(/\bslide\s+\d+(?:\s+of\s+\d+)?\b/gi, "").replace(/\b\d+\s*\/\s*\d+\s*$/, "").replace(/\s+/g, " ").trim();
    return cleaned ? `--- Slide ${n} ---\n${cleaned}` : "";
  }).filter(Boolean);
  return slides.join("\n\n");
}

/* ---------------- public API ---------------- */

// Returns { text } for documents we can read ourselves, or { inline: { mimeType, buffer } } for
// files we hand straight to the model (PDF/images).
function extractDocument({ buffer, mimetype, filename }) {
  if (!buffer || !buffer.length) throw new HttpError(400, "That file was empty.");
  const ext = extOf(filename);
  const type = (mimetype || "").toLowerCase();

  if (type === PPTX_TYPE || ext === "pptx") {
    const text = extractPptx(buffer).slice(0, MAX_TEXT_CHARS);
    if (!text) throw new HttpError(400, "No text could be found in that PowerPoint file.");
    return { text };
  }
  if (type === DOCX_TYPE || ext === "docx") {
    const text = extractDocx(buffer).slice(0, MAX_TEXT_CHARS);
    if (!text) throw new HttpError(400, "No text could be found in that document.");
    return { text };
  }
  if (type === PDF_TYPE || ext === "pdf") return { inline: { mimeType: PDF_TYPE, buffer } };
  if (IMAGE_TYPES.has(type) || ["png", "jpg", "jpeg", "webp", "heic", "heif"].includes(ext)) {
    return { inline: { mimeType: type.startsWith("image/") ? type : "image/jpeg", buffer } };
  }
  if (TEXT_TYPES.has(type) || ["txt", "md", "markdown", "csv"].includes(ext)) {
    const text = buffer.toString("utf8").slice(0, MAX_TEXT_CHARS);
    if (!text.trim()) throw new HttpError(400, "That text file was empty.");
    return { text };
  }
  throw new HttpError(400, "Unsupported file. Upload a PPTX, PDF, image, TXT/MD file, or paste the text instead.");
}

// .docx shares the OOXML zip layout; body text lives in word/document.xml.
function extractDocx(buf) {
  const entries = readZipEntries(buf);
  const entry = entries.find((e) => e.name === "word/document.xml");
  if (!entry) throw new HttpError(400, "That Word file couldn't be read.");
  const xml = readZipEntry(buf, entry);
  if (!xml) throw new HttpError(400, "That Word file couldn't be read.");
  const paragraphs = xml.toString("utf8").split(/<\/w:p>/).map(textFromSlideXml).filter(Boolean);
  return paragraphs.join("\n");
}

module.exports = { extractDocument, extractPptx, extractDocx };
