export const TDF_OFFERS_URL = "https://nycgw47.tdf.org/TDFCustomOfferings/Current";
export const TDF_PERFORMANCES_URL =
  "https://nycgw47.tdf.org/TDFCustomOfferings/Current?handler=Performances";

type TdfKeyword = {
  categoryId: number;
  categoryName: string;
  keywordId: number;
  keywordName: string;
};

type TdfPerformance = {
  performanceId: number;
  performanceDate: string;
};

export type TdfOffer = {
  productionSeasonId: number;
  title: string;
  facility: string;
  keywords: TdfKeyword[];
  thumbnail: string;
  performances: TdfPerformance[];
  isTAP: boolean;
  isNew: boolean;
  promotions: TdfKeyword[];
};

export type SeenState = {
  seen: string[];
};

export type AlertItem = {
  id: string;
  productionSeasonId: number;
  performanceId: number;
  performanceDate: string;
  title: string;
  facility: string;
  thumbnail: string;
  categories: string[];
  promotions: string[];
};

export function parseTdfOffers(input: unknown): TdfOffer[] {
  if (!Array.isArray(input)) {
    throw new Error("TDF response was not a JSON array.");
  }

  return input.map((item, index) => parseOffer(item, index));
}

export function flattenOffers(offers: TdfOffer[]): AlertItem[] {
  return offers.flatMap((offer) =>
    offer.performances.map((performance) => ({
      id: makeAlertId(offer.productionSeasonId, performance.performanceId),
      productionSeasonId: offer.productionSeasonId,
      performanceId: performance.performanceId,
      performanceDate: performance.performanceDate,
      title: offer.title,
      facility: offer.facility,
      thumbnail: offer.thumbnail,
      categories: offer.keywords.map((keyword) => keyword.keywordName),
      promotions: offer.promotions.map((promotion) => promotion.keywordName)
    }))
  );
}

export function findNewAlerts(items: AlertItem[], state: SeenState): AlertItem[] {
  const seen = new Set(state.seen);
  return items.filter((item) => !seen.has(item.id));
}

export function markSeen(state: SeenState, items: AlertItem[]): SeenState {
  const seen = new Set(state.seen);
  for (const item of items) {
    seen.add(item.id);
  }

  return { seen: [...seen].sort() };
}

export function parseSeenState(input: unknown): SeenState {
  if (!isRecord(input) || !Array.isArray(input["seen"])) {
    throw new Error("Seen state must contain a seen array.");
  }

  if (!input["seen"].every((value) => typeof value === "string")) {
    throw new Error("Seen state contains a non-string id.");
  }

  return { seen: [...new Set(input["seen"])].sort() };
}

function makeAlertId(productionSeasonId: number, performanceId: number): string {
  return `${productionSeasonId}:${performanceId}`;
}

function parseOffer(input: unknown, index: number): TdfOffer {
  if (!isRecord(input)) {
    throw new Error(`Offer at index ${index} was not an object.`);
  }

  return {
    productionSeasonId: numberField(input, "productionSeasonId", index),
    title: stringField(input, "title", index),
    facility: stringField(input, "facility", index),
    keywords: keywordArray(input["keywords"], "keywords", index),
    thumbnail: stringField(input, "thumbnail", index),
    performances: performanceArray(input["performances"], index),
    isTAP: booleanField(input, "isTAP", index),
    isNew: booleanField(input, "isNew", index),
    promotions: keywordArray(input["promotions"], "promotions", index)
  };
}

function performanceArray(input: unknown, offerIndex: number): TdfPerformance[] {
  if (!Array.isArray(input)) {
    throw new Error(`Offer at index ${offerIndex} has invalid performances.`);
  }

  return input.map((performance, performanceIndex) => {
    if (!isRecord(performance)) {
      throw new Error(
        `Performance at index ${offerIndex}.${performanceIndex} was not an object.`
      );
    }

    return {
      performanceId: numberField(performance, "performanceId", offerIndex),
      performanceDate: stringField(performance, "performanceDate", offerIndex)
    };
  });
}

function keywordArray(input: unknown, field: string, offerIndex: number): TdfKeyword[] {
  if (!Array.isArray(input)) {
    throw new Error(`Offer at index ${offerIndex} has invalid ${field}.`);
  }

  return input.map((keyword, keywordIndex) => {
    if (!isRecord(keyword)) {
      throw new Error(`${field} at index ${offerIndex}.${keywordIndex} was not an object.`);
    }

    return {
      categoryId: numberField(keyword, "categoryId", offerIndex),
      categoryName: stringField(keyword, "categoryName", offerIndex),
      keywordId: numberField(keyword, "keywordId", offerIndex),
      keywordName: stringField(keyword, "keywordName", offerIndex)
    };
  });
}

function stringField(input: Record<string, unknown>, field: string, index: number): string {
  const value = input[field];
  if (typeof value !== "string") {
    throw new Error(`Offer at index ${index} has invalid ${field}.`);
  }

  return value;
}

function numberField(input: Record<string, unknown>, field: string, index: number): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Offer at index ${index} has invalid ${field}.`);
  }

  return value;
}

function booleanField(input: Record<string, unknown>, field: string, index: number): boolean {
  const value = input[field];
  if (typeof value !== "boolean") {
    throw new Error(`Offer at index ${index} has invalid ${field}.`);
  }

  return value;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
