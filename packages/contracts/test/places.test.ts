import { describe, expect, it } from "vitest";
import { PlaceParams, PlacePointQuery, PlacePointResponse, PlaceSearchQuery, PlaceSearchResponse } from "../src/index";

const session = "00000000-0000-4000-8000-000000000401";
const match = { id: "ChIJ-baner_1", title: "Baner Road", detail: "Baner, Pune, Maharashtra" };

describe("PlaceSearchQuery", () => {
  it("trims the text and takes 1 to 100 characters, with a session", () => {
    expect(PlaceSearchQuery.parse({ text: " Baner ", session })).toEqual({ text: "Baner", session });
    expect(PlaceSearchQuery.safeParse({ text: "   ", session }).success).toBe(false);
    expect(PlaceSearchQuery.safeParse({ text: "a".repeat(101), session }).success).toBe(false);
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

describe("PlaceParams", () => {
  it("takes a Google place id of letters, digits, _ and -", () => {
    expect(PlaceParams.parse({ id: match.id })).toEqual({ id: match.id });
    expect(PlaceParams.safeParse({ id: "" }).success).toBe(false);
    expect(PlaceParams.safeParse({ id: "a/../b" }).success).toBe(false);
    expect(PlaceParams.safeParse({ id: "a".repeat(301) }).success).toBe(false);
  });
});

describe("PlacePointQuery and PlacePointResponse", () => {
  it("needs a session, and answers a point in India", () => {
    expect(PlacePointQuery.safeParse({ session }).success).toBe(true);
    expect(PlacePointQuery.safeParse({}).success).toBe(false);
    expect(PlacePointResponse.safeParse({ point: { latitude: 18.559, longitude: 73.7868 } }).success).toBe(true);
    expect(PlacePointResponse.safeParse({ point: { latitude: 0, longitude: 0 } }).success).toBe(false);
  });
});
