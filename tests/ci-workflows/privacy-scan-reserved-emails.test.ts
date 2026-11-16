/**
 * The scanner read two non-mailboxes as addresses and failed the gate.
 *
 * `proxy.example` is a proxy URL's host in a redaction fixture; `.example` is reserved for
 * documentation by RFC 6761, so no mailbox exists behind it. The other is a clone remote in its
 * SSH form, whose local part is the transport account GitHub assigns, not a person.
 *
 * This exercises the real `scanText`, so widening either allowance still has to keep a real
 * address a finding.
 */
import { describe, expect, test } from "bun:test";
import { scanText } from "../../scripts/privacy-scan";

/** Assembled at runtime so this file carries no bare address of its own. */
const mailbox = (local: string, domain: string): string => [local, domain].join("@");

describe("privacy scan: reserved documentation domains and remotes", () => {
  test("a reserved .example host is documentation, not a mailbox", () => {
    const line = `expect(redactSecretString("socks5://user:prefix@${mailbox("password-suffix", "proxy.example")}:1080"))`;
    expect(scanText("tests/lib/redact.test.ts", line).filter(finding => finding.kind === "email")).toEqual([]);
  });

  test("a packaged or hosted domain beside the reserved word is still a finding", () => {
    for (const domain of ["proxy.example.com", "example.testing"]) {
      const line = `contact ${mailbox("member", domain)}`;
      expect(scanText("tests/example.test.ts", line).some(finding => finding.kind === "email")).toBe(true);
    }
  });

  test("the clone remote form is not a mailbox", () => {
    const line = `expect(redactSecretString("${mailbox("git", "github.com")}:o/r.git")).toBe(value);`;
    expect(scanText("tests/lib/redact.test.ts", line).filter(finding => finding.kind === "email")).toEqual([]);
  });

  test("the same host with a person in front is still a finding", () => {
    const line = `contact ${mailbox("member", "github.com")} about this`;
    expect(scanText("tests/example.test.ts", line).some(finding => finding.kind === "email")).toBe(true);
  });
});
