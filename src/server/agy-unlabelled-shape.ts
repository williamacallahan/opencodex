/**
 * A content-free diagnostic for agy generate requests the body scan could not label with a session.
 *
 * It logs the shape of the body, never its content: key names that look like identifiers (anything else is
 * `<other>`), the JSON type of three named values with a length and a closed class for strings, the
 * `requestType` mode name when it is enum-like, the character-class pattern of the top-level `requestId` (no character of it survives), and the body size rounded up to a power of two. Values, the
 * project, request ids, prompt text and headers are never read into the line. It is bounded for life: one
 * line per distinct shape, 8 lines, 64 remembered shapes and 64 body walks per process, and the body is not touched
 * once any cap is reached.
 */
export interface JsonScanners {
  skipWs(bytes: Uint8Array, pos: number): number;
  scanStr(bytes: Uint8Array, start: number): { end: number; escaped: boolean } | null;
  skipVal(bytes: Uint8Array, start: number): number;
}

const MAX_LINES = 8;
/** Every walk of a body counts, logged or not, so a process never walks more than this many bodies. */
const MAX_WALKS = 64;
const MAX_SHAPES = 64;
const MAX_NAMES = 40;
const MAX_STRING_CLASS_BYTES = 64;
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const MODE_NAME = /^[A-Za-z_-]{1,24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decoder = new TextDecoder();
const seenShapes = new Set<string>();
let linesLogged = 0;
let walks = 0;

interface Member {
  readonly name: string;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/** The members of the JSON object at `start`, in order (at most 40), or null when it is not a well-formed object prefix. */
function members(bytes: Uint8Array, start: number, scan: JsonScanners): Member[] | null {
  if (bytes[start] !== 0x7B) return null;
  const found: Member[] = [];
  let pos = start + 1;
  while (found.length < MAX_NAMES) {
    pos = scan.skipWs(bytes, pos);
    if (bytes[pos] === 0x7D) return found;
    const key = scan.scanStr(bytes, pos);
    if (!key) return null;
    const rawLength = key.end - (pos + 1);
    const text = !key.escaped && rawLength <= MAX_NAMES ? decoder.decode(bytes.subarray(pos + 1, key.end)) : "";
    const name = KEY_NAME.test(text) ? text : "<other>";
    pos = scan.skipWs(bytes, key.end + 1);
    if (bytes[pos] !== 0x3A) return null;
    const valueStart = scan.skipWs(bytes, pos + 1);
    const valueEnd = scan.skipVal(bytes, valueStart);
    if (valueEnd < 0) return null;
    found.push({ name, valueStart, valueEnd });
    pos = scan.skipWs(bytes, valueEnd);
    if (bytes[pos] === 0x2C) {
      pos += 1;
      continue;
    }
    return bytes[pos] === 0x7D ? found : null;
  }
  return found;
}

const first = (list: readonly Member[], name: string): Member | undefined => list.find(member => member.name === name);

function stringClass(text: string): string {
  if (text.length === 0) return "empty";
  if (UUID.test(text)) return "uuid";
  if (/^-[0-9]+$/.test(text)) return "signed-digits";
  if (/^[0-9]+$/.test(text)) return "digits";
  if (/^[0-9a-fA-F]+$/.test(text)) return "hex";
  return "other";
}

/** `type`, or `string/<byte length>/<class>` for a string. Only the length and the class leave this function. */
function describeValue(bytes: Uint8Array, member: Member | undefined, scan: JsonScanners): string {
  if (!member) return "absent";
  const lead = bytes[member.valueStart];
  if (lead === 0x22) {
    const token = scan.scanStr(bytes, member.valueStart);
    if (!token) return "string";
    const length = token.end - (member.valueStart + 1);
    const text = !token.escaped && length <= MAX_STRING_CLASS_BYTES ? decoder.decode(bytes.subarray(member.valueStart + 1, token.end)) : "\u0000";
    return `string/${length}/${text === "\u0000" ? "other" : stringClass(text)}`;
  }
  if (lead === 0x7B) return "object";
  if (lead === 0x5B) return "array";
  if (lead === 0x74 || lead === 0x66) return "boolean";
  if (lead === 0x6E) return "null";
  return "number";
}

const MAX_PATTERN_SOURCE_BYTES = 200;

/**
 * The character-class pattern of a string, so that no character of it survives: a run of hex digits and `a`-`f`
 * is `h<count>` (`d<count>` when all are decimal digits), any other ASCII letter run is `a<count>`, each of
 * `/ - _ . :` stays itself, and any other character is `?`.
 */
export function characterClassPattern(text: string): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    const ch = text.charCodeAt(i);
    const digit = ch >= 0x30 && ch <= 0x39;
    const hexLetter = (ch >= 0x61 && ch <= 0x66) || (ch >= 0x41 && ch <= 0x46);
    const letter = hexLetter || (ch >= 0x61 && ch <= 0x7A) || (ch >= 0x41 && ch <= 0x5A);
    if (digit || hexLetter) {
      let end = i;
      let allDigits = true;
      for (; end < text.length; end += 1) {
        const c = text.charCodeAt(end);
        const isDigit = c >= 0x30 && c <= 0x39;
        if (!isDigit && !((c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46))) break;
        if (!isDigit) allDigits = false;
      }
      out += `${allDigits ? "d" : "h"}${end - i}`;
      i = end;
    } else if (letter) {
      let end = i;
      for (; end < text.length; end += 1) {
        const c = text.charCodeAt(end);
        const hex = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
        if (hex || !((c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A))) break;
      }
      out += `a${end - i}`;
      i = end;
    } else {
      out += "/-_.:".includes(text[i]!) ? text[i]! : "?";
      i += 1;
    }
  }
  return out;
}

function requestIdPattern(bytes: Uint8Array, member: Member | undefined, scan: JsonScanners): string {
  if (!member || bytes[member.valueStart] !== 0x22) return "absent";
  const token = scan.scanStr(bytes, member.valueStart);
  if (!token) return "absent";
  if (token.end - (member.valueStart + 1) > MAX_PATTERN_SOURCE_BYTES) return "toolong";
  // Decoded as JSON so an escape is classed by the character it stands for, never by its spelling.
  try {
    const value: unknown = JSON.parse(decoder.decode(bytes.subarray(member.valueStart, token.end + 1)));
    if (typeof value !== "string") return "absent";
    return value.length > MAX_PATTERN_SOURCE_BYTES ? "toolong" : characterClassPattern(value);
  } catch {
    return "absent";
  }
}

const bucket = (bytes: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, bytes)));
const logfmt = (text: string): string => /^[A-Za-z0-9_.:\-/@]+$/.test(text) ? text : JSON.stringify(text);

/** The log line for a body, or undefined when the body is not a well-formed enough JSON object. Exported for tests. */
export function unlabelledShapeFields(bytes: Uint8Array, scan: JsonScanners): [string, string][] | undefined {
  const top = members(bytes, scan.skipWs(bytes, 0), scan);
  if (!top) return undefined;
  const requestMember = first(top, "request");
  const request = requestMember && bytes[requestMember.valueStart] === 0x7B ? members(bytes, requestMember.valueStart, scan) : null;
  if (requestMember && bytes[requestMember.valueStart] === 0x7B && !request) return undefined;
  const labelsMember = request ? first(request, "labels") : undefined;
  const labels = labelsMember && bytes[labelsMember.valueStart] === 0x7B ? members(bytes, labelsMember.valueStart, scan) : null;
  const requestType = first(top, "requestType");
  let mode = "absent";
  if (requestType && bytes[requestType.valueStart] === 0x22) {
    const token = scan.scanStr(bytes, requestType.valueStart);
    if (token && !token.escaped && token.end - requestType.valueStart <= 25) {
      const text = decoder.decode(bytes.subarray(requestType.valueStart + 1, token.end));
      if (MODE_NAME.test(text)) mode = text;
    }
  }
  const list = (names: readonly Member[] | null): string => names ? names.map(member => member.name).join(",") : "absent";
  return [
    ["top_keys", list(top)],
    ["request_keys", requestMember ? (request ? list(request) : describeValue(bytes, requestMember, scan)) : "absent"],
    ["label_keys", list(labels)],
    ["session_id", describeValue(bytes, request ? first(request, "sessionId") : undefined, scan)],
    ["request_type", describeValue(bytes, requestType, scan)],
    ["request_type_value", mode],
    ["trajectory_id", describeValue(bytes, labels ? first(labels, "trajectory_id") : undefined, scan)],
    ["request_id_pattern", requestIdPattern(bytes, first(top, "requestId"), scan)],
    ["body_bytes_bucket", String(bucket(bytes.byteLength))],
  ];
}

/** Log the shape of one unlabelled generate body at most once per shape; never throws. */
export function logUnlabelledGenerateShape(bytes: Uint8Array, scan: JsonScanners): void {
  if (linesLogged >= MAX_LINES || seenShapes.size >= MAX_SHAPES || walks >= MAX_WALKS) return;
  walks += 1;
  try {
    const fields = unlabelledShapeFields(bytes, scan);
    if (!fields) return;
    const signature = fields.filter(([name]) => name !== "body_bytes_bucket" && name !== "request_id_pattern").map(([, value]) => value).join("|");
    if (seenShapes.has(signature)) return;
    seenShapes.add(signature);
    linesLogged += 1;
    console.info(`[opencodex] level=info event=agy.unlabelled_generate_shape ${fields.map(([name, value]) => `${name}=${logfmt(value)}`).join(" ")}`);
  } catch {
    // A diagnostic never affects the relay.
  }
}

export function resetUnlabelledShapeLogForTests(): void {
  seenShapes.clear();
  linesLogged = 0;
  walks = 0;
}
