import { describe, expect, it } from "vitest";
import { mapEntitiesToMatches } from "./ner.js";

function redacted(word: string): string {
  return `${word[0]}${"*".repeat(word.length - 1)}`;
}

describe("mapEntitiesToMatches", () => {
  it("maps PER/ORG/LOC to person/organization/location", () => {
    const matches = mapEntitiesToMatches([
      { entity_group: "PER", score: 0.99, word: "Sarah Connor" },
      { entity_group: "ORG", score: 0.98, word: "Cyberdyne Systems" },
      { entity_group: "LOC", score: 0.97, word: "Los Angeles" },
    ]);
    expect(matches).toEqual([
      { patternType: "person", redactedSample: redacted("Sarah Connor") },
      { patternType: "organization", redactedSample: redacted("Cyberdyne Systems") },
      { patternType: "location", redactedSample: redacted("Los Angeles") },
    ]);
  });

  it("drops MISC entities as too broad to be a useful signal", () => {
    const matches = mapEntitiesToMatches([{ entity_group: "MISC", score: 0.99, word: "Olympics" }]);
    expect(matches).toEqual([]);
  });

  it("drops entities below the confidence threshold", () => {
    const matches = mapEntitiesToMatches([{ entity_group: "PER", score: 0.5, word: "John" }]);
    expect(matches).toEqual([]);
  });

  it("keeps entities right at the confidence threshold", () => {
    const matches = mapEntitiesToMatches([{ entity_group: "PER", score: 0.85, word: "John" }]);
    expect(matches).toHaveLength(1);
  });

  it("redacts a single-character word as a single asterisk", () => {
    const matches = mapEntitiesToMatches([{ entity_group: "PER", score: 0.99, word: "X" }]);
    expect(matches[0].redactedSample).toBe("*");
  });

  it("returns no matches for an empty entity list", () => {
    expect(mapEntitiesToMatches([])).toEqual([]);
  });
});
