import { describe, expect, it } from "vitest";
import { PlaceId, PlaceMatch, PlacePointQuery, PlacePointResponse, PlaceSearchQuery, PlaceSearchResponse, PlaceSearchText } from "../src/index";

const session = "00000000-0000-4000-8000-000000000401";
const match = { id: "ChIJ-baner_1", title: "Baner Road", detail: "Baner, Pune, Maharashtra" };

describe("PlaceSearchText", () => {
  it("trims, takes 1 to 100 characters, and refuses control characters", () => {
    expect(PlaceSearchText.parse(" Baner ")).toBe("Baner");
    expect(PlaceSearchText.safeParse("   ").success).toBe(false);
    expect(PlaceSearchText.safeParse("a".repeat(100)).success).toBe(true);
    expect(PlaceSearchText.safeParse("a".repeat(101)).success).toBe(false);
    expect(PlaceSearchText.safeParse("Baner\0").success).toBe(false);
    expect(PlaceSearchText.safeParse("Baner\u0007Road").success).toBe(false);
    expect(PlaceSearchText.safeParse("बाणेर रोड").success).toBe(true);
  });
});

describe("PlaceSearchQuery", () => {
  it("takes the text with a session", () => {
    expect(PlaceSearchQuery.parse({ text: " Baner ", session })).toEqual({ text: "Baner", session });
    expect(PlaceSearchQuery.safeParse({ text: "Baner", session: "s1" }).success).toBe(false);
    expect(PlaceSearchQuery.safeParse({ text: "Baner" }).success).toBe(false);
  });
});

describe("PlaceSearchResponse", () => {
  it("holds up to 5 matches", () => {
    expect(PlaceSearchResponse.parse({ matches: [] })).toEqual({ matches: [] });
    expect(PlaceSearchResponse.safeParse({ matches: Array(5).fill(match) }).success).toBe(true);
    expect(PlaceSearchResponse.safeParse({ matches: Array(6).fill(match) }).success).toBe(false);
  });
});

describe("PlaceId", () => {
  it("takes Google's letters, digits, _ and -, past 100 characters, in a match and a pick alike", () => {
    const long = `Ei${"x".repeat(150)}`;
    expect(PlaceId.safeParse(match.id).success).toBe(true);
    expect(PlaceId.safeParse(long).success).toBe(true);
    expect(PlaceId.safeParse("").success).toBe(false);
    expect(PlaceId.safeParse("a/../b").success).toBe(false);
    expect(PlaceId.safeParse("a".repeat(1001)).success).toBe(false);
    expect(PlaceMatch.safeParse({ ...match, id: long }).success).toBe(true);
    expect(PlaceMatch.safeParse({ ...match, id: "a/b" }).success).toBe(false);
    expect(PlacePointQuery.safeParse({ id: long, session }).success).toBe(true);
  });
});

describe("PlacePointQuery and PlacePointResponse", () => {
  it("needs an id and a session, and answers a point in India", () => {
    expect(PlacePointQuery.safeParse({ id: match.id, session }).success).toBe(true);
    expect(PlacePointQuery.safeParse({ id: match.id }).success).toBe(false);
    expect(PlacePointResponse.safeParse({ point: { latitude: 18.559, longitude: 73.7868 } }).success).toBe(true);
    expect(PlacePointResponse.safeParse({ point: { latitude: 0, longitude: 0 } }).success).toBe(false);
  });
});
