import { Buffer, isUtf8 } from "node:buffer";
import { decodeRequestBody, DecompressedBodyTooLargeError } from "./request-decompress";

export type CacheTier = "tools" | "system" | "messages";
export type CacheTtl = 300000 | 3600000;
export interface CachePosition { readonly digest: string; readonly tier: CacheTier; readonly index: number }
export interface CacheBreakpoint { readonly index: number; readonly ttl: CacheTtl }
export type PrefixUnsupportedReason =
  | "invalid_json" | "body_limit" | "structure_limit" | "content_encoding"
  | "unsupported_shape" | "invalid_marker" | "ttl_order" | "breakpoint_limit"
  | "tool_run_breakpoint";
export type PrefixWalk =
  | { readonly status: "supported"; readonly positions: readonly CachePosition[]; readonly breakpoints: readonly CacheBreakpoint[] }
  | { readonly status: "unsupported"; readonly reason: PrefixUnsupportedReason };

interface ByteNode {
  start: number;
  end: number;
  properties?: { key: string; start: number; child: ByteNode }[];
  children?: ByteNode[];
}
class UnsupportedPrefix extends Error {
  constructor(readonly reason: PrefixUnsupportedReason) { super(reason); }
}
function refuse(reason: PrefixUnsupportedReason): never { throw new UnsupportedPrefix(reason); }

// Keep spans, not parsed prompt strings or a second serialized body. The limits also bound
// nesting and metadata allocation for a small body containing many tiny JSON containers.
function parseBytes(bytes: Buffer): ByteNode {
  let cursor = 0;
  let nodes = 0;
  const space = () => {
    while ([32, 9, 10, 13].includes(bytes[cursor] ?? -1)) cursor++;
  };
  function stringEnd(): void {
    if (bytes[cursor++] !== 34) refuse("invalid_json");
    while (cursor < bytes.length) {
      const byte = bytes[cursor++]!;
      if (byte === 34) return;
      if (byte < 32) refuse("invalid_json");
      if (byte !== 92) continue;
      const escape = bytes[cursor++];
      if (escape === 117) {
        for (let digit = 0; digit < 4; digit++) {
          const hex = bytes[cursor++];
          if (hex === undefined || !(hex >= 48 && hex <= 57 || hex >= 65 && hex <= 70 || hex >= 97 && hex <= 102)) refuse("invalid_json");
        }
      } else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(escape ?? -1)) refuse("invalid_json");
    }
    refuse("invalid_json");
  }
  function parse(depth: number): ByteNode {
    if (depth > 128 || ++nodes > 131072) refuse("structure_limit");
    space();
    const node: ByteNode = { start: cursor, end: 0 };
    const byte = bytes[cursor];
    if (byte === 34) stringEnd();
    else if (byte === 123) {
      cursor++;
      space();
      node.properties = [];
      const keys = new Set<string>();
      if (bytes[cursor] !== 125) for (;;) {
        const start = cursor;
        stringEnd();
        const key: unknown = JSON.parse(bytes.toString("utf8", start, cursor));
        if (typeof key !== "string" || keys.has(key)) refuse("invalid_json");
        keys.add(key);
        space();
        if (bytes[cursor++] !== 58) refuse("invalid_json");
        node.properties.push({ key, start, child: parse(depth + 1) });
        space();
        if (bytes[cursor] !== 44) break;
        cursor++;
        space();
      }
      if (bytes[cursor++] !== 125) refuse("invalid_json");
    } else if (byte === 91) {
      cursor++;
      space();
      node.children = [];
      if (bytes[cursor] !== 93) for (;;) {
        node.children.push(parse(depth + 1));
        space();
        if (bytes[cursor] !== 44) break;
        cursor++;
      }
      if (bytes[cursor++] !== 93) refuse("invalid_json");
    } else {
      while (cursor < bytes.length && ![44, 93, 125, 32, 9, 10, 13].includes(bytes[cursor]!)) cursor++;
      const literal = bytes.toString("utf8", node.start, cursor);
      if (!/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(literal)) refuse("invalid_json");
    }
    node.end = cursor;
    return node;
  }
  const root = parse(0);
  space();
  if (cursor !== bytes.length) refuse("invalid_json");
  return root;
}
function field(node: ByteNode, key: string): ByteNode | undefined {
  return node.properties?.find(property => property.key === key)?.child;
}
function stringScalar(bytes: Buffer, node: ByteNode | undefined): string | undefined {
  if (!node || bytes[node.start] !== 34) return undefined;
  const parsed: unknown = JSON.parse(bytes.toString("utf8", node.start, node.end));
  return typeof parsed === "string" ? parsed : undefined;
}
function spansWithoutMarker(bytes: Buffer, node: ByteNode): Buffer[] {
  const properties = node.properties;
  const index = properties?.findIndex(property => property.key === "cache_control") ?? -1;
  if (!properties || index < 0) return [bytes.subarray(node.start, node.end)];
  if (properties.length === 1) return [Buffer.from("{}")];
  const start = index === 0 ? properties[0]!.start : properties[index - 1]!.child.end;
  const end = index === 0 ? properties[1]!.start : properties[index]!.child.end;
  return [bytes.subarray(node.start, start), bytes.subarray(end, node.end)];
}
function markerTtl(bytes: Buffer, node: ByteNode): CacheTtl {
  if (!node.properties || node.properties.some(property => !["type", "ttl"].includes(property.key))
    || stringScalar(bytes, field(node, "type")) !== "ephemeral") refuse("invalid_marker");
  const ttl = field(node, "ttl");
  if (!ttl) return 300000;
  switch (stringScalar(bytes, ttl)) {
    case "5m": return 300000;
    case "1h": return 3600000;
    default: return refuse("invalid_marker");
  }
}

/** A breakpoint searches itself and nineteen preceding positions, not twenty preceding ones. */
export function isCachePositionReachable(index: number, breakpoints: readonly CacheBreakpoint[]): boolean {
  return breakpoints.some(point => point.index >= index && point.index - index < 20);
}

/** Run in the resident observation worker, after confirmed prefill, never before forwarding.
 * Input is the untouched entity copy; decompression is bounded independently of wire size.
 * Raw representation differences deliberately remain conservative mismatches.
 */
export function walkPromptCachePrefix(input: Uint8Array, contentEncoding: string | null = null): PrefixWalk {
  const maxBytes = 32 * 1024 * 1024;
  if (input.byteLength > maxBytes) return { status: "unsupported", reason: "body_limit" };
  let decoded: Uint8Array;
  try { decoded = decodeRequestBody(input, contentEncoding, maxBytes); }
  catch (error) {
    return { status: "unsupported", reason: error instanceof DecompressedBodyTooLargeError ? "body_limit" : "content_encoding" };
  }
  try {
    const bytes = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    if (!isUtf8(bytes)) refuse("invalid_json");
    const root = parseBytes(bytes);
    const messages = field(root, "messages");
    if (!root.properties || !messages?.children) refuse("unsupported_shape");
    for (const property of root.properties) {
      if (!["model", "tools", "system", "messages", "cache_control", "thinking", "output_config", "speed",
        "tool_choice", "max_tokens", "stream", "metadata", "temperature", "top_p", "top_k", "stop_sequences", "service_tier"].includes(property.key)) refuse("unsupported_shape");
    }
    const state = new Bun.CryptoHasher("sha256");
    const positions: CachePosition[] = [];
    const breakpoints: CacheBreakpoint[] = [];
    function frame(name: string, parts: readonly Buffer[]): void {
      state.update(`${name}:${parts.reduce((sum, part) => sum + part.length, 0)}:`);
      for (const part of parts) state.update(part);
    }
    function parameter(key: string): void {
      const node = field(root, key);
      if (node) frame(`parameter:${key}`, [bytes.subarray(node.start, node.end)]);
    }
    function position(tier: CacheTier, blocks: readonly ByteNode[]): void {
      if (positions.length >= 16384) refuse("structure_limit");
      let marker: ByteNode | undefined;
      for (const [index, block] of blocks.entries()) {
        const candidate = field(block, "cache_control");
        // A marker inside a collapsed run cannot be attributed to the run's final digest.
        if (candidate && index !== blocks.length - 1) refuse("tool_run_breakpoint");
        marker = candidate;
        frame(tier, spansWithoutMarker(bytes, block));
      }
      const index = positions.length;
      positions.push({ digest: state.copy().digest("hex"), tier, index });
      if (marker) breakpoints.push({ index, ttl: markerTtl(bytes, marker) });
    }
    frame("version", [Buffer.from("1")]);
    // Thinking/effort placement is model-specific: conservatively invalidate every tier.
    for (const key of ["model", "thinking", "output_config"]) parameter(key);
    const tools = field(root, "tools");
    if (tools && !tools.children) refuse("unsupported_shape");
    for (const tool of tools?.children ?? []) {
      const type = stringScalar(bytes, field(tool, "type"));
      if (!tool.properties || !field(tool, "name") || !field(tool, "input_schema")
        || field(tool, "type") && type !== "custom" || field(tool, "defer_loading")) refuse("unsupported_shape");
      position("tools", [tool]);
    }
    // A changed tool catalog invalidates even a breakpoint before the changed tool.
    // Bind snapshots to the complete catalog without rereading its bytes per prefix.
    const catalogDigest = state.copy().digest("hex");
    for (const [index, position] of positions.entries()) {
      positions[index] = { ...position, digest: new Bun.CryptoHasher("sha256")
        .update(`tools-catalog:${catalogDigest}:prefix:${position.digest}`).digest("hex") };
    }
    parameter("speed");
    const system = field(root, "system");
    if (system?.children) {
      for (const block of system.children) {
        if (stringScalar(bytes, field(block, "type")) !== "text") refuse("unsupported_shape");
        position("system", [block]);
      }
    } else if (system) {
      if (stringScalar(bytes, system) === undefined) refuse("unsupported_shape");
      position("system", [system]);
    }
    parameter("tool_choice");
    for (const message of messages.children) {
      if (!message.properties || message.properties.some(property => !["role", "content"].includes(property.key))) refuse("unsupported_shape");
      const role = field(message, "role");
      const content = field(message, "content");
      if (!role || !content || !["user", "assistant", "system"].includes(stringScalar(bytes, role) ?? "")) refuse("unsupported_shape");
      frame("message", [bytes.subarray(role.start, role.end)]);
      if (!content.children) {
        if (stringScalar(bytes, content) === undefined) refuse("unsupported_shape");
        position("messages", [content]);
        continue;
      }
      for (let cursor = 0; cursor < content.children.length;) {
        const block = content.children[cursor++]!;
        const kind = stringScalar(bytes, field(block, "type"));
        // Images/documents, signed thinking and server tools can change provider rendering
        // or accounting outside these byte spans. Report the coverage gap, not false warmth.
        if (!kind || !["text", "tool_use", "tool_result"].includes(kind)) refuse("unsupported_shape");
        const run = [block];
        if (kind === "tool_use" || kind === "tool_result") {
          while (cursor < content.children.length && stringScalar(bytes, field(content.children[cursor]!, "type")) === kind) {
            run.push(content.children[cursor++]!);
          }
        }
        if (kind === "tool_result") for (const resultBlock of run) {
          const result = field(resultBlock, "content");
          if (result?.children && result.children.some(child => stringScalar(bytes, field(child, "type")) !== "text")) refuse("unsupported_shape");
        }
        position("messages", run);
      }
    }
    const automatic = field(root, "cache_control");
    if (automatic && positions.length) {
      const ttl = markerTtl(bytes, automatic);
      const index = positions.length - 1;
      const previous = breakpoints.find(point => point.index === index);
      if (previous && previous.ttl !== ttl) refuse("invalid_marker");
      if (!previous) breakpoints.push({ index, ttl });
    }
    if (breakpoints.length > 4) refuse("breakpoint_limit");
    for (let index = 1; index < breakpoints.length; index++) {
      if (breakpoints[index - 1]!.ttl < breakpoints[index]!.ttl) refuse("ttl_order");
    }
    return { status: "supported", positions, breakpoints };
  } catch (error) {
    if (error instanceof UnsupportedPrefix) return { status: "unsupported", reason: error.reason };
    if (error instanceof SyntaxError) return { status: "unsupported", reason: "invalid_json" };
    throw error;
  }
}
