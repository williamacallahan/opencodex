/**
 * A second process reading the usage filter index of `OPENCODEX_HOME`, driven one command per stdin
 * line; each answer is one stdout line starting with `@@`. It shares no memory with the test process,
 * so what it knows of the ledger is only what its own reads observed.
 */
import { runPassiveRead } from "../../src/lib/passive-read";
import { handleManagementAPI } from "../../src/server/management-api";
import { readUsageFilterCandidates, readUsageFilterCandidatesPassive } from "../../src/usage/filter-index";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest } from "./management-auth";

const config: OcxConfig = { port: 0, hostname: "127.0.0.1", defaultProvider: "test", providers: {} };

interface ArchiveCoverage { complete: boolean; summary: unknown; coverage: { liveLedgerSince: string | null; ambiguousSegments: string[] } }

async function archive(query: string): Promise<ArchiveCoverage> {
  const req = new ManagementRequest(`http://localhost/api/usage/archive?${query}`, { method: "GET" });
  const response = await handleManagementAPI(req, new URL(req.url), config, {});
  return await response!.json() as ArchiveCoverage;
}

async function answer(command: string, args: string[]): Promise<unknown> {
  switch (command) {
    case "passive-candidate": {
      const read = await runPassiveRead(() => readUsageFilterCandidatesPassive({ provider: null, model: null, apiKeyId: null }));
      read?.close();
      return { read: read !== null };
    }
    case "passive-minimum":
      return { liveLedgerSince: (await runPassiveRead(() => archive(args[0]!))).coverage.liveLedgerSince };
    case "count": {
      const read = await readUsageFilterCandidates({ provider: null, model: null, apiKeyId: null, window: { since: Number(args[0]), until: Number(args[1]) } });
      let candidates = 0;
      try {
        for (let page = read!.nextPage(); page.length > 0; page = read!.nextPage()) candidates += page.length;
      } finally {
        read?.close();
      }
      return { candidates };
    }
    case "archive-until": {
      // Active reads, which schedule this process's own catch-up, until the earliest row is `args[1]`.
      let body = await archive(args[0]!);
      for (const started = Date.now(); body.coverage.liveLedgerSince !== args[1] && Date.now() - started < 10_000; body = await archive(args[0]!)) {
        await Bun.sleep(25);
      }
      return body;
    }
    default:
      throw new Error(`unknown command ${command}`);
  }
}

for await (const line of console) {
  const [command, ...args] = line.trim().split(" ");
  if (command === "exit") process.exit(0);
  console.log(`@@${JSON.stringify(await answer(command!, args))}`);
}
