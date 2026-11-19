import { expect, test } from "bun:test";
import { estimateClaudeRequestTokens } from "../../src/server/claude-messages";
import { estimateTokens } from "../../src/lib/token-estimate";

/** Minimal PNG header (signature + IHDR) so the attachment sniffer can read real dimensions. */
function countTokensPngBase64(width: number, height: number): string {
  const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...u32be(13), 0x49, 0x48, 0x44, 0x52, // len + "IHDR"
    ...u32be(width), ...u32be(height),
    8, 6, 0, 0, 0, // bit depth, color type, etc.
  ];
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}

test("estimateClaudeRequestTokens matches the plain char estimate for text-only bodies", () => {
  const raw = {
    system: "be brief",
    messages: [{ role: "user", content: "count me please, this is a sentence" }],
    tools: [{ name: "Read", input_schema: { type: "object" } }],
  };
  const parts = [raw.system, JSON.stringify(raw.messages), JSON.stringify(raw.tools)];
  expect(estimateClaudeRequestTokens(raw, "m")).toBe(Math.max(1, estimateTokens(parts.join("\n"), "m")));
});

test("estimateClaudeRequestTokens prices sniffable images by pixel dimensions", () => {
  const raw = {
    messages: [{
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: countTokensPngBase64(1500, 2000) } }],
    }],
  };
  const estimate = estimateClaudeRequestTokens(raw, "m");
  // ceil(1500 * 2000 / 750) = 4000 attachment tokens plus the JSON skeleton.
  expect(estimate).toBeGreaterThanOrEqual(4000);
  expect(estimate).toBeLessThan(4100);
});

test("estimateClaudeRequestTokens strips base64 documents nested in tool_result content", () => {
  const raw = {
    messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "t1",
        content: [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "Q".repeat(400_000) } }],
      }],
    }],
  };
  const estimate = estimateClaudeRequestTokens(raw, "m");
  // ceil(400000 * 3/4 / 512) = 586 tokens, nowhere near the ~114k a char count would report.
  expect(estimate).toBeGreaterThanOrEqual(586);
  expect(estimate).toBeLessThan(1000);
});

test("estimateClaudeRequestTokens does not charge base64 padding as payload bytes", () => {
  // Exactly 131072 decoded bytes: 174764 base64 chars ending in "=". Counting the padding
  // would yield 131073 bytes and charge 257 tokens instead of 256.
  const data = Buffer.from(new Uint8Array(131_072)).toString("base64");
  const raw = {
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }],
  };
  const stripped = {
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }] }],
  };

  expect(estimateClaudeRequestTokens(raw, "m")).toBe(
    Math.max(1, estimateTokens(JSON.stringify(stripped.messages), "m") + 256),
  );
});

test("estimateClaudeRequestTokens keeps base64-shaped tool_use input counted as text", () => {
  // tool_use.input is serialized into function_call arguments and sent upstream, so a
  // {type:"base64", data} shape inside it is NOT an attachment and must count as text.
  const raw = {
    messages: [{
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "upload", input: { type: "base64", data: "B".repeat(40_000) } }],
    }],
  };

  expect(estimateClaudeRequestTokens(raw, "m")).toBe(
    Math.max(1, estimateTokens(JSON.stringify(raw.messages), "m")),
  );
});

test("estimateClaudeRequestTokens leaves complete attachment-shaped tool_use input intact", () => {
  // Even a full {type:"image", source:{type:"base64", data}} object inside tool_use.input
  // is a tool argument, not an attachment: the translator replays it verbatim inside
  // function_call arguments, so it must count at its serialized size.
  const raw = {
    messages: [{
      role: "assistant",
      content: [{
        type: "tool_use",
        id: "t1",
        name: "upload_image",
        input: { type: "image", source: { type: "base64", media_type: "image/png", data: "C".repeat(50_000) } },
      }],
    }],
  };

  expect(estimateClaudeRequestTokens(raw, "m")).toBe(
    Math.max(1, estimateTokens(JSON.stringify(raw.messages), "m")),
  );
});

test("estimateClaudeRequestTokens leaves attachment-shaped tool schemas intact", () => {
  // Tool definitions are forwarded to routed providers; an attachment-shaped example in a
  // schema is not an attachment either.
  const raw = {
    messages: [{ role: "user", content: "hi" }],
    tools: [{
      name: "upload",
      input_schema: { type: "object" },
      example: { type: "image", source: { type: "base64", media_type: "image/png", data: "D".repeat(30_000) } },
    }],
  };
  const parts = [JSON.stringify(raw.messages), JSON.stringify(raw.tools)];

  expect(estimateClaudeRequestTokens(raw, "m")).toBe(
    Math.max(1, estimateTokens(parts.join("\n"), "m")),
  );
});

test("estimateClaudeRequestTokens counts text-source documents as ordinary text", () => {
  const text = "plain text document body ".repeat(40);
  const raw = {
    messages: [{
      role: "user",
      content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: text } }],
    }],
  };
  expect(estimateClaudeRequestTokens(raw, "m")).toBe(Math.max(1, estimateTokens(JSON.stringify(raw.messages), "m")));
});
