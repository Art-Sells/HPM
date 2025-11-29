import { PairRequest, Quote, QuoteSeed, VenueAdapter, VenueId } from "../types";

type FixtureMap = Record<string, QuoteSeed[]>;

export class StaticAdapter implements VenueAdapter {
  public readonly id: VenueId;
  private readonly fixtures: FixtureMap;

  constructor(id: VenueId, fixtures: FixtureMap) {
    this.id = id;
    this.fixtures = fixtures;
  }

  async fetchQuotes(pairs: PairRequest[]): Promise<Quote[]> {
    const now = Date.now();
    return pairs.flatMap((pair) => {
      const key = `${pair.base}/${pair.quote}`;
      return (this.fixtures[key] || []).map((seed) => ({
        ...seed,
        venueId: this.id,
        timestamp: now,
      }));
    });
  }
}

