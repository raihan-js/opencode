import { describe, expect, test } from "bun:test"
import { Notebook } from "@opencode-ai/core/notebook/notebook"

const { emptyNotebook, createRanker } = Notebook

// Offline eval for notes_get ranking: a small fixture exercising the failure
// modes of pure token-overlap scoring (arbitrary tie-breaks, no phrase
// signal, unbounded path accumulation). Each query pins the entry that must
// rank first; if a scoring change breaks one of these, it broke a real
// retrieval behavior, not just a number.
//
// Fixture with 6 entries and 2 relations:
//   auth.ts     — token refresh flow (the phrase "token refresh" verbatim)
//   cache.ts    — token cache refresh on a schedule (same tokens, no phrase)
//   session.ts  — session expiry windows (rare terms in a "user"-heavy corpus)
//   onboard.ts  — user onboarding (generic-token distractor)
//   config.ts   — user config handling (generic-token distractor)
//   migrate.ts  — db migrations, many based_on paths sharing the "db" token
const buildFixture = () => {
  const src = emptyNotebook("/project/src", "src")
  src.entries["auth.ts"] = {
    name: "auth.ts",
    summary: "Token refresh flow: rotates the access token before it expires.",
    based_on: ["src/auth.ts@1-40"],
    confidence: "verified",
  }
  src.entries["cache.ts"] = {
    name: "cache.ts",
    summary: "Refresh the token cache on a schedule.",
    based_on: [],
    confidence: "observed",
  }
  src.entries["session.ts"] = {
    name: "session.ts",
    summary: "Session expiry windows for authenticated user sessions.",
    based_on: ["src/session.ts@1-30"],
    confidence: "observed",
  }
  src.entries["onboard.ts"] = {
    name: "onboard.ts",
    summary: "User onboarding walkthrough shown after the first login.",
    based_on: [],
    confidence: "observed",
  }
  src.entries["config.ts"] = {
    name: "config.ts",
    summary: "User config handling: loads and validates settings files.",
    based_on: ["src/config.ts@1-50"],
    confidence: "observed",
  }
  const db = emptyNotebook("/project/src/db", "src/db")
  db.entries["migrate.ts"] = {
    name: "migrate.ts",
    summary: "Applies pending migrations in order and records applied versions.",
    based_on: ["src/db/migrate.ts@1-99", "src/db/versions.ts@1-20", "src/db/runner.ts@1-10"],
    confidence: "observed",
  }
  src.relations = [
    { from: "auth.ts", to: "session.ts", description: "auth refresh hook updates the session expiry", based_on: [], confidence: "inferred" },
    { from: "cache.ts", to: "auth.ts", description: "cache syncs from the token store", based_on: [], confidence: "observed" },
  ]
  return [src, db]
}

describe("Notebook ranking eval", () => {
  const notebooks = buildFixture()
  const ranker = createRanker(notebooks)
  const topEntry = (query: string): string => {
    const scored = notebooks
      .flatMap((nb) => Object.values(nb.entries).map((entry) => ({ name: entry.name, score: ranker.scoreEntry(entry, query) })))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
    return scored[0]?.name ?? ""
  }
  const topRelation = (query: string): string => {
    const scored = notebooks
      .flatMap((nb) => nb.relations.map((rel) => ({ rel, score: ranker.scoreRelation(rel, query) })))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
    return scored[0] ? `${scored[0].rel.from}->${scored[0].rel.to}` : ""
  }

  test("phrase query ranks the verbatim match over the token-scatter distractor", () => {
    expect(topEntry("token refresh")).toBe("auth.ts")
  })

  test("rare terms outrank generic ones shared across the corpus", () => {
    expect(topEntry("session expiry")).toBe("session.ts")
  })

  test("name field carries a precise file lookup", () => {
    expect(topEntry("migrate")).toBe("migrate.ts")
    expect(topEntry("config")).toBe("config.ts")
  })

  test("generic multi-token queries still resolve to the specific note", () => {
    expect(topEntry("user config handling")).toBe("config.ts")
  })

  test("path evidence ranks the touched file", () => {
    expect(topEntry("pending migrations")).toBe("migrate.ts")
  })

  test("relation ranking prefers the matching description", () => {
    expect(topRelation("refresh hook")).toBe("auth.ts->session.ts")
    expect(topRelation("token store sync")).toBe("cache.ts->auth.ts")
  })

  test("ranking is deterministic across ranker instances", () => {
    const again = createRanker(buildFixture())
    for (const query of ["token refresh", "session expiry", "migrate", "user config handling"]) {
      expect(topEntry(query)).toBe(
        notebooks
          .flatMap((nb) => Object.values(nb.entries).map((entry) => ({ name: entry.name, score: again.scoreEntry(entry, query) })))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score)[0]?.name,
      )
    }
  })
})
