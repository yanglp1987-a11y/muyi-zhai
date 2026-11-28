const ALLOWED_TAGS = new Set(["p","br","h1","h2","h3","strong","b","em","i","u","s","del","ul","ol","li","blockquote","span","img"]);
const VOID_TAGS = new Set(["br","img"]);
const DANGEROUS_TAGS = new Set(["script","style","iframe","object","embed","svg","math","template","noscript"]);
const FONT_SIZES = new Set(["12pt","14pt","16pt","18pt","20pt","24pt","28pt","32pt"]);
const IMAGE_PATH = /^\/images\/articles\/[a-f0-9-]{36}\.(?:jpe?g|png|gif|webp)(?:\?v=\d{1,16})?$/i;
const PROXY_IMAGE_PATH = /^\/images\/proxy\/[a-f0-9-]{36}\.(?:jpe?g|png|gif|webp)(?:\?v=\d{1,16})?$/i;
const PAGES_IMAGE_URL = /^https:\/\/muyi-zhai\.pages\.dev\/images\/articles\/[a-f0-9-]{36}\.(?:jpe?g|png|gif|webp)(?:\?v=\d{1,16})?$/i;
const PAGES_PROXY_IMAGE_URL = /^https:\/\/muyi-zhai\.pages\.dev\/images\/proxy\/[a-f0-9-]{36}\.(?:jpe?g|png|gif|webp)(?:\?v=\d{1,16})?$/i;
const GITHUB_RAW_IMAGE_URL = /^https:\/\/raw\.githubusercontent\.com\/yanglp1987-a11y\/muyi-zhai\/main\/public\/images\/articles\/[a-f0-9-]{36}\.(?:jpe?g|png|gif|webp)(?:\?v=\d{1,16})?$/i;

function escapeText(value) {
  return value.replace(/&(?!(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);)/gi, "&amp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function decodeAttribute(value) {
  return value.replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");
}
function parseAttributes(source) {
  const attrs = Object.create(null);
  let i = 0;
  while (i < source.length) {
    while (/\s/.test(source[i] || "")) i++;
    if (i >= source.length || source[i] === "/") break;
    const start = i;
    while (i < source.length && !/[\s=/>]/.test(source[i])) i++;
    if (start === i) { i++; continue; }
    const name = source.slice(start, i).toLowerCase();
    while (/\s/.test(source[i] || "")) i++;
    let value = "";
    if (source[i] === "=") {
      i++;
      while (/\s/.test(source[i] || "")) i++;
      const quote = source[i] === '"' || source[i] === "'" ? source[i++] : "";
      const valueStart = i;
      if (quote) {
        while (i < source.length && source[i] !== quote) i++;
        value = source.slice(valueStart, i);
        if (source[i] === quote) i++;
      } else {
        while (i < source.length && !/[\s>]/.test(source[i])) i++;
        value = source.slice(valueStart, i);
      }
    }
    if (!(name in attrs)) attrs[name] = decodeAttribute(value);
  }
  return attrs;
}
function safeStyle(style, tag) {
  const output = [];
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 1) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim().toLowerCase();
    if (name === "font-size" && FONT_SIZES.has(value)) output.push("font-size: " + value);
    if (name === "color" && /^#[0-9a-f]{6}$/i.test(value)) output.push("color: " + value);
    if (tag === "img" && name === "width" && /^(25|50|75|100)%$/.test(value)) output.push("width: " + value);
    if (tag === "img" && name === "height" && value === "auto") output.push("height: auto");
    if (tag === "img" && name === "max-width" && value === "100%") output.push("max-width: 100%");
    if ((tag === "p" || tag === "h1" || tag === "h2" || tag === "h3") &&
        name === "text-align" && ["left","center","right"].includes(value)) output.push("text-align: " + value);
  }
  return output.join("; ");
}
function readTag(html, start) {
  let i = start + 1, quote = "";
  for (; i < html.length; i++) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = ""; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return { raw: html.slice(start + 1, i), end: i + 1 };
  }
  return null;
}
function serializeAttrs(tag, attrs) {
  const out = [];
  if (tag === "img") {
    const src = attrs.src || "";
    if (!IMAGE_PATH.test(src) && !PROXY_IMAGE_PATH.test(src) && !PAGES_IMAGE_URL.test(src) &&
        !PAGES_PROXY_IMAGE_URL.test(src) && !GITHUB_RAW_IMAGE_URL.test(src)) return null;
    out.push('src="' + src + '"');
    if (attrs.alt) out.push('alt="' + escapeText(attrs.alt.slice(0,200)) + '"');
    if (attrs.width && /^\d{1,4}$/.test(attrs.width) && Number(attrs.width) > 0) out.push('width="' + attrs.width + '"');
    if (attrs.height && /^\d{1,4}$/.test(attrs.height) && Number(attrs.height) > 0) out.push('height="' + attrs.height + '"');
  }
  if (["p","h1","h2","h3","span","img"].includes(tag) && attrs.style) {
    const style = safeStyle(attrs.style, tag);
    if (style) out.push('style="' + style + '"');
  }
  return out.length ? " " + out.join(" ") : "";
}
export function sanitizeRichHtml(input) {
  if (typeof input !== "string" || input.length > 100000) return "";
  let output = "", i = 0, skipTag = null, skipDepth = 0;
  while (i < input.length) {
    if (input[i] !== "<") {
      const next = input.indexOf("<", i);
      const end = next < 0 ? input.length : next;
      if (!skipTag) output += escapeText(input.slice(i, end));
      i = end; continue;
    }
    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4);
      i = end < 0 ? input.length : end + 3; continue;
    }
    const token = readTag(input, i);
    if (!token) { if (!skipTag) output += "&lt;"; i++; continue; }
    const raw = token.raw.trim();
    const match = raw.match(/^(\/)?\s*([a-z][a-z0-9:-]*)\b([\s\S]*)$/i);
    if (!match) { if (!skipTag) output += "&lt;" + escapeText(raw) + "&gt;"; i = token.end; continue; }
    const closing = !!match[1], tag = match[2].toLowerCase(), tail = match[3];
    if (skipTag) {
      if (tag === skipTag) { if (closing) skipDepth--; else if (!/\/$/.test(tail.trim())) skipDepth++; if (skipDepth <= 0) skipTag = null; }
      i = token.end; continue;
    }
    if (!closing && DANGEROUS_TAGS.has(tag)) { skipTag = tag; skipDepth = 1; i = token.end; continue; }
    if (!ALLOWED_TAGS.has(tag)) { i = token.end; continue; }
    if (closing) { if (!VOID_TAGS.has(tag)) output += "</" + tag + ">"; }
    else {
      const attrs = parseAttributes(tail);
      const serialized = serializeAttrs(tag, attrs);
      if (serialized !== null) output += "<" + tag + serialized + (VOID_TAGS.has(tag) ? ">" : ">");
    }
    i = token.end;
  }
  return output.trim();
}
