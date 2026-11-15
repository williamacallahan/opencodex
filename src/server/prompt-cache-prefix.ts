import { Buffer, isUtf8 } from "node:buffer";
import { decodeRequestBody, DecompressedBodyTooLargeError } from "./request-decompress";

export type CacheTier = "tools" | "system" | "messages";
export type CacheTtl = 300000 | 3600000;
export interface CachePosition { readonly digest: string; readonly tier: CacheTier; readonly index: number; readonly blockEnd: number }
export interface CacheBreakpoint { readonly index: number; readonly ttl: CacheTtl }
export type PrefixUnsupportedReason =
  | "invalid_json" | "body_limit" | "structure_limit" | "content_encoding"
  | "unsupported_shape" | "invalid_marker" | "ttl_order" | "breakpoint_limit"
  | "tool_run_breakpoint" | "unsupported_request_field" | "context_transform"
  | "unsupported_tool" | "unsupported_block" | "unsupported_media_source"
  | "unsupported_message_field" | "unresolved_tool_reference";
export type PrefixWalk =
  | { readonly status: "supported"; readonly positions: readonly CachePosition[]; readonly breakpoints: readonly CacheBreakpoint[]; readonly reuseBoundary?: number }
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
  if (!node.properties || node.properties.some(property => !["type", "ttl", "scope"].includes(property.key))
    || stringScalar(bytes, field(node, "type")) !== "ephemeral") refuse("invalid_marker");
  const scope = field(node, "scope");
  if (scope && stringScalar(bytes, scope) !== "global") refuse("invalid_marker");
  const ttl = field(node, "ttl");
  if (!ttl) return 300000;
  switch (stringScalar(bytes, ttl)) {
    case "5m": return 300000;
    case "1h": return 3600000;
    default: return refuse("invalid_marker");
  }
}

/** A breakpoint searches itself and nineteen preceding content blocks. Distance is counted in
 * blocks (each tool_use, tool_result and nested result child), never in collapsed positions;
 * overcounting only yields a false miss, undercounting would yield a false loss. */
export function isCachePositionReachable(index: number, breakpoints: readonly CacheBreakpoint[], positions: readonly CachePosition[]): boolean {
  const candidate = positions[index];
  return candidate !== undefined && breakpoints.some(point => {
    const end = positions[point.index];
    return end !== undefined && point.index >= index && end.blockEnd - candidate.blockEnd < 20;
  });
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
      if (["context_management", "thread", "compaction"].includes(property.key)) refuse("context_transform");
      if (!["model", "tools", "system", "messages", "cache_control", "thinking", "output_config", "speed",
        "tool_choice", "max_tokens", "stream", "metadata", "temperature", "top_p", "top_k", "stop_sequences", "service_tier", "diagnostics"].includes(property.key)) refuse("unsupported_request_field");
    }
    const diagnostics = field(root, "diagnostics");
    if (diagnostics && (!diagnostics.properties || diagnostics.properties.some(property => property.key !== "previous_message_id"))) refuse("unsupported_request_field");
    const automatic = field(root, "cache_control");
    const automaticTtl = automatic ? markerTtl(bytes, automatic) : undefined;
    const state = new Bun.CryptoHasher("sha256");
    const positions: CachePosition[] = [];
    const breakpoints: CacheBreakpoint[] = [];
    const toolNames = new Set<string>();
    let reuseBoundary = 0;
    let lastCacheable = -1;
    let hasThinking = false;
    const isString = (node: ByteNode | undefined): boolean => node !== undefined && bytes[node.start] === 34;
    function inspectBlock(block: ByteNode, nested = false): void {
      const kind = stringScalar(bytes, field(block, "type"));
      if (nested && field(block, "cache_control")) refuse("invalid_marker");
      if (kind === "text") {
        if (!isString(field(block, "text"))) refuse("unsupported_block");
      } else if (kind === "thinking" || kind === "redacted_thinking") {
        if (nested || !isString(field(block, kind === "thinking" ? "thinking" : "data"))
          || kind === "thinking" && !isString(field(block, "signature"))) refuse("unsupported_block");
        hasThinking = true;
      } else if (kind === "tool_use") {
        if (nested) refuse("unsupported_block");
      } else if (kind === "tool_result") {
        if (nested) refuse("unsupported_block");
        const content = field(block, "content");
        if (content?.children) for (const child of content.children) inspectBlock(child, true);
        else if (content && !isString(content)) refuse("unsupported_block");
      } else if (kind === "tool_reference") {
        const name = stringScalar(bytes, field(block, "tool_name"));
        if (!nested || !name || !toolNames.has(name)) refuse("unresolved_tool_reference");
        // Definitions can expand outside the visible block positions. Only prefixes after
        // this complete result remain attributable; retain all physical markers for validation.
        reuseBoundary = positions.length;
      } else if (kind === "image" || kind === "document") {
        const source = field(block, "source");
        if (!source?.properties) refuse("unsupported_media_source");
        const sourceType = stringScalar(bytes, field(source, "type"));
        if (sourceType === "base64" || kind === "document" && sourceType === "text") {
          if (!isString(field(source, "data")) || !isString(field(source, "media_type"))) refuse("unsupported_media_source");
        } else if (kind === "document" && sourceType === "content") {
          const content = field(source, "content");
          if (content?.children) for (const child of content.children) {
            if (!["text", "image"].includes(stringScalar(bytes, field(child, "type")) ?? "")) refuse("unsupported_block");
            inspectBlock(child, true);
          }
          else if (!isString(content)) refuse("unsupported_media_source");
        } else refuse("unsupported_media_source");
      } else if (kind === "search_result") {
        const content = field(block, "content");
        if (!content?.children) refuse("unsupported_block");
        for (const child of content.children) {
          if (stringScalar(bytes, field(child, "type")) !== "text") refuse("unsupported_block");
          inspectBlock(child, true);
        }
      } else refuse("unsupported_block");
    }
    function frame(name: string, parts: readonly Buffer[]): void {
      state.update(`${name}:${parts.reduce((sum, part) => sum + part.length, 0)}:`);
      for (const part of parts) state.update(part);
    }
    function parameter(key: string): void {
      const node = field(root, key);
      if (node) frame(`parameter:${key}`, [bytes.subarray(node.start, node.end)]);
    }
    let blockEnd = 0;
    function blockWeight(node: ByteNode): number {
      let weight = 1;
      for (const container of [field(node, "content"), field(field(node, "source") ?? node, "content")]) {
        if (container?.children) for (const child of container.children) weight += blockWeight(child);
      }
      return weight;
    }
    function position(tier: CacheTier, blocks: readonly ByteNode[], cacheable = true): void {
      if (positions.length >= 16384) refuse("structure_limit");
      for (const block of blocks) blockEnd += blockWeight(block);
      let ttl: CacheTtl | undefined;
      for (const [index, block] of blocks.entries()) {
        const candidate = field(block, "cache_control");
        // A marker inside a collapsed run cannot be attributed to the run's final digest.
        if (candidate && index !== blocks.length - 1) refuse("tool_run_breakpoint");
        ttl = candidate ? markerTtl(bytes, candidate) : undefined;
        if (candidate && !cacheable) refuse("invalid_marker");
        const scope = candidate && field(candidate, "scope");
        if (scope) frame("cache-scope", [bytes.subarray(scope.start, scope.end)]);
        frame(tier, spansWithoutMarker(bytes, block));
      }
      const index = positions.length;
      positions.push({ digest: state.copy().digest("hex"), tier, index, blockEnd });
      if (cacheable) lastCacheable = index;
      if (ttl !== undefined) breakpoints.push({ index, ttl });
    }
    frame("version", [Buffer.from("1")]);
    const automaticScope = automatic && field(automatic, "scope");
    if (automaticScope) frame("automatic-cache-scope", [bytes.subarray(automaticScope.start, automaticScope.end)]);
    // Thinking/effort placement is model-specific: conservatively invalidate every tier.
    for (const key of ["model", "thinking", "output_config"]) parameter(key);
    const tools = field(root, "tools");
    if (tools && !tools.children) refuse("unsupported_shape");
    for (const tool of tools?.children ?? []) {
      const type = stringScalar(bytes, field(tool, "type"));
      const name = stringScalar(bytes, field(tool, "name"));
      const deferred = field(tool, "defer_loading");
      if (!tool.properties || !name || !field(tool, "input_schema") || field(tool, "type") && type !== "custom"
        || deferred && ![102, 116].includes(bytes[deferred.start]!)) refuse("unsupported_tool");
      toolNames.add(name);
      position("tools", [tool], !deferred || bytes[deferred.start] !== 116);
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
        if (stringScalar(bytes, field(block, "type")) !== "text") refuse("unsupported_block");
        position("system", [block]);
      }
    } else if (system) {
      if (stringScalar(bytes, system) === undefined) refuse("unsupported_shape");
      position("system", [system]);
    }
    parameter("tool_choice");
    for (const message of messages.children) {
      if (!message.properties || message.properties.some(property => !["role", "content", "output_config"].includes(property.key))) refuse("unsupported_message_field");
      const role = field(message, "role");
      const content = field(message, "content");
      if (!role || !content || !["user", "assistant", "system"].includes(stringScalar(bytes, role) ?? "")) refuse("unsupported_shape");
      if (stringScalar(bytes, role) === "user" && hasThinking
        && !content.children?.every(block => stringScalar(bytes, field(block, "type")) === "tool_result")) {
        // Older models strip prior thinking once a user message carries anything besides
        // tool results (e.g. a system-reminder text beside one). Do not claim reuse across
        // that boundary without a model-specific preservation guarantee.
        reuseBoundary = positions.length;
      }
      frame("message", [bytes.subarray(role.start, role.end)]);
      const output = field(message, "output_config");
      if (output) {
        if (stringScalar(bytes, role) !== "system" || !output.properties || output.properties.some(property => property.key !== "effort")) refuse("unsupported_message_field");
        frame("message-output-config", [bytes.subarray(output.start, output.end)]);
        if (content.children?.length === 0) position("messages", [content], false);
      }
      if (!content.children) {
        if (stringScalar(bytes, content) === undefined) refuse("unsupported_shape");
        position("messages", [content]);
        continue;
      }
      for (let cursor = 0; cursor < content.children.length;) {
        const block = content.children[cursor++]!;
        const kind = stringScalar(bytes, field(block, "type"));
        const run = [block];
        if (kind === "tool_use" || kind === "tool_result") {
          while (cursor < content.children.length && stringScalar(bytes, field(content.children[cursor]!, "type")) === kind) {
            run.push(content.children[cursor++]!);
          }
        }
        for (const entry of run) inspectBlock(entry);
        position("messages", run, kind !== "thinking" && kind !== "redacted_thinking");
      }
    }
    if (automaticTtl !== undefined && lastCacheable >= 0) {
      const ttl = automaticTtl;
      const index = lastCacheable;
      const previous = breakpoints.find(point => point.index === index);
      if (previous && previous.ttl !== ttl) refuse("invalid_marker");
      if (!previous) breakpoints.push({ index, ttl });
    }
    if (breakpoints.length > 4) refuse("breakpoint_limit");
    for (let index = 1; index < breakpoints.length; index++) {
      if (breakpoints[index - 1]!.ttl < breakpoints[index]!.ttl) refuse("ttl_order");
    }
    return { status: "supported", positions, breakpoints, ...(reuseBoundary > 0 ? { reuseBoundary } : {}) };
  } catch (error) {
    if (error instanceof UnsupportedPrefix) return { status: "unsupported", reason: error.reason };
    if (error instanceof SyntaxError) return { status: "unsupported", reason: "invalid_json" };
    throw error;
  }
}
