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
  // Google's own examples (developers.google.com/maps/documentation/places/web-service/place-id): a place, an
  // address, an intersection, and an address in Hyderabad written in Telugu, 679 characters long.
  const googles = [
    "ChIJgUbEo8cfqokR5lP9_Wh_DaM",
    "EicxMyBNYXJrZXQgU3QsIFdpbG1pbmd0b24sIE5DIDI4NDAxLCBVU0EiGhIYChQKEgnRTo6ixx-qiRHo_bbmkCm7ZRAN",
    "GhIJQWDl0CIeQUARxks3icF8U8A",
    "IhoSGAoUChIJ0U6OoscfqokR6P225pApu2UQDQ",
    "EpID4LC14LC_4LCo4LCv4LGN4LCo4LCX4LCw4LGNIC0g4LC44LGI4LCm4LGN4LCs4LC-4LCm4LGNIOCwsOCxi-CwoeCxjeCwoeCxgSAmIOCwteCwv-CwqOCwr-CxjSDgsKjgsJfgsLDgsY0g4LCu4LGG4LCv4LC_4LCo4LGNIOCwsOCxi-CwoeCxjeCwoeCxgSwg4LC14LC_4LCo4LCv4LGNIOCwqOCwl-CwsOCxjSDgsJXgsL7gsLLgsKjgsYAsIOCwsuCwleCxjeCwt-CxjeCwruCwv-CwqOCwl-CwsOCxjSDgsJXgsL7gsLLgsKjgsYAsIOCwuOCwsOCxguCwsOCxjSDgsKjgsJfgsLDgsY0g4LC14LGG4LC44LGN4LCf4LGNLCDgsLjgsK_gsYDgsKbgsL7gsKzgsL7gsKbgsY0sIOCwueCxiOCwpuCwsOCwvuCwrOCwvuCwpuCxjSwg4LCk4LGG4LCy4LCC4LCX4LC-4LCjIDUwMDA1OSwg4LCt4LC-4LCw4LCk4LCm4LGH4LC24LCCImYiZAoUChIJ31l5uGWYyzsR9zY2qk9lDiASFAoSCd9ZebhlmMs7Efc2NqpPZQ4gGhQKEglDz61OZpjLOxHgDJCFY-o1qBoUChIJi37TW2-YyzsRr_uv50r7tdEiCg1MwFcKFS_dyy4",
  ];

  it("takes every id Google shows, long ones too, in a match and a pick alike", () => {
    for (const id of googles) {
      expect(PlaceId.safeParse(id).success).toBe(true);
      expect(PlaceMatch.safeParse({ ...match, id }).success).toBe(true);
      expect(PlacePointQuery.safeParse({ id, session }).success).toBe(true);
    }
    expect(PlaceId.safeParse("a".repeat(4096)).success).toBe(true);
  });

  it("assumes no character set Google doesn't document", () => {
    for (const id of ["a.b", "a~b", "a+b=", "a/b", "a?b", "a#b", "a%2Fb", "a b", "...", "बाणेर"]) {
      expect(PlaceId.safeParse(id).success).toBe(true);
      expect(PlaceMatch.safeParse({ ...match, id }).success).toBe(true);
    }
  });

  it("refuses an empty id, one past 4096 characters, control characters, and the dot segments", () => {
    expect(PlaceId.safeParse("").success).toBe(false);
    expect(PlaceId.safeParse("a".repeat(4097)).success).toBe(false);
    for (const id of ["a\0b", "a\nb", "a\u007fb", ".", ".."]) expect(PlaceId.safeParse(id).success).toBe(false);
    expect(PlacePointQuery.safeParse({ id: "..", session }).success).toBe(false);
  });

  it("stays one segment of Google's path once the server encodes it", () => {
    for (const id of ["a/../b", "../places:autocomplete", "a?key=x#y", "%2e%2e", "...", "a\\b", ...googles]) {
      expect(PlaceId.safeParse(id).success).toBe(true);
      const segment = encodeURIComponent(id);
      expect(segment).toMatch(/^[^/?#\\]+$/);
      expect(segment).not.toMatch(/^(?:\.|%2e){1,2}$/i);
      expect(decodeURIComponent(segment)).toBe(id);
    }
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
