import { PlaceId, type PlaceMatch } from "@ygo/contracts";

/**
 * C15's place search (#257): the server asks Google Places, so the key stays
 * here (Q4). A test passes a stand-in.
 */
export interface PlaceFinder {
  /** Up to 5 places in India for the text, in Google's order; rejects when Google doesn't answer. */
  search(text: string, session: string): Promise<PlaceMatch[]>;
  /** The place's point, or null when Google no longer knows it; rejects when Google doesn't answer. */
  point(id: string, session: string): Promise<{ latitude: number; longitude: number } | null>;
}

const PLACES_URL = "https://places.googleapis.com/v1";
const TIMEOUT_MS = 5_000;

type Text = { text?: string };
type Autocomplete = {
  suggestions?: { placePrediction?: { placeId?: string; structuredFormat?: { mainText?: Text; secondaryText?: Text } } }[];
};

/**
 * Places API (New). The search is Autocomplete limited to India; the point is
 * Place Details asking only for the location, which Google bills as Essentials
 * and which ends the search's session (Q5).
 */
export function createGooglePlaceFinder(key: string, fetcher: typeof fetch = fetch): PlaceFinder {
  async function ask(path: string, fieldMask: string, body?: object): Promise<Response> {
    return fetcher(`${PLACES_URL}${path}`, {
      method: body ? "POST" : "GET",
      headers: { ...(body && { "Content-Type": "application/json" }), "X-Goog-Api-Key": key, "X-Goog-FieldMask": fieldMask },
      ...(body && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** Lets go of an unread error answer, then rejects. */
  async function failed(answer: Response, call: string): Promise<never> {
    await answer.body?.cancel();
    throw new Error(`Places ${call} answered ${answer.status}`);
  }

  return {
    async search(text, session) {
      const answer = await ask(
        "/places:autocomplete",
        "suggestions.placePrediction.placeId,suggestions.placePrediction.structuredFormat",
        { input: text, sessionToken: session, includedRegionCodes: ["in"], languageCode: "en" },
      );
      if (!answer.ok) return failed(answer, "search");
      const { suggestions = [] } = (await answer.json()) as Autocomplete;
      const seen = new Set<string>();
      return suggestions
        .flatMap(({ placePrediction: place }) => {
          const id = place?.placeId;
          const title = place?.structuredFormat?.mainText?.text;
          if (!id || !PlaceId.safeParse(id).success || !title || seen.has(id)) return [];
          seen.add(id);
          return [{ id, title, detail: place.structuredFormat?.secondaryText?.text ?? "" }];
        })
        .slice(0, 5);
    },

    async point(id, session) {
      const answer = await ask(`/places/${encodeURIComponent(id)}?${new URLSearchParams({ sessionToken: session })}`, "location");
      // Google answers an unknown or retired place id with 404.
      if (answer.status === 404) {
        await answer.body?.cancel();
        return null;
      }
      if (!answer.ok) return failed(answer, "point");
      const { location } = (await answer.json()) as { location?: { latitude?: number; longitude?: number } };
      return typeof location?.latitude === "number" && typeof location.longitude === "number"
        ? { latitude: location.latitude, longitude: location.longitude }
        : null;
    },
  };
}
