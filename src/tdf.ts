export const TDF_MEMBER_HOME_URL = "https://members.tdf.org/store/";
export const TDF_OFFERS_URL = "https://members.tdf.org/store/category/performances/0ZGPe00000003CPOAY";
export const TDF_API_BASE_URL =
  "https://members.tdf.org/store/webruntime/api/services/data/v67.0/commerce/webstores/0ZEfK000000qcIvWAI";
export const TDF_APEX_EXECUTE_URL =
  "https://members.tdf.org/store/webruntime/api/apex/execute?language=en-US&asGuest=false&htmlEncode=false";
export const TDF_CSRF_TOKEN_MODULE_URL = "https://members.tdf.org/store/webruntime/module/@app/csrfToken";
export const TDF_TICKET_BOOKING_CLASS_NAME = "@udd/01pPe000001jpVz";
export const TDF_SESSION_CONTEXT_URL =
  `${TDF_API_BASE_URL}/session-context?language=en-US&asGuest=false&htmlEncode=false`;
export const TDF_PERFORMANCES_CATEGORY_ID = "0ZGPe00000003CPOAY";
export const TDF_PRODUCT_FIELDS = [
  "Name",
  "Description",
  "StockKeepingUnit",
  "Performance_Date__c",
  "PerformanceDate__c",
  "Start_Date__c",
  "StartDate__c",
  "Event_Date__c",
  "Venue__c",
  "Facility__c",
  "Location__c",
  "Theater__c",
  "Theatre__c",
  "ProductionSeasonId__c",
  "Production_Season_Id__c",
  "PerformanceId__c",
  "Performance_Id__c"
].join(",");

type TdfKeyword = {
  categoryId: number;
  categoryName: string;
  keywordId: number;
  keywordName: string;
};

type TdfPerformance = {
  performanceId: string | number;
  performanceDate: string;
};

export type TdfOffer = {
  productionSeasonId: string | number;
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
  productionSeasonId: string | number;
  performanceId: string | number;
  performanceDate: string;
  title: string;
  facility: string;
  thumbnail: string;
  categories: string[];
  promotions: string[];
};

export function parseTdfOffers(input: unknown): TdfOffer[] {
  const storefrontProducts = productsFromStorefrontPayload(input);
  if (storefrontProducts) {
    return offersFromStorefrontProducts(storefrontProducts);
  }

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

function makeAlertId(productionSeasonId: string | number, performanceId: string | number): string {
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

function productsFromStorefrontPayload(input: unknown): Array<Record<string, unknown>> | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  if (Array.isArray(input["products"])) {
    return input["products"].filter(isRecord);
  }
  if (isRecord(input["productsPage"]) && Array.isArray(input["productsPage"]["products"])) {
    return input["productsPage"]["products"].filter(isRecord);
  }
  return undefined;
}

function offerFromStorefrontProduct(product: Record<string, unknown>, index: number): TdfOffer | undefined {
  const fields = isRecord(product["fields"]) ? product["fields"] : {};
  const id = stringValue(product["id"]) ?? `product-${index}`;
  const title = fieldString(fields, ["Name"]) ?? stringValue(product["name"]);
  if (!title) {
    return undefined;
  }
  const facility =
    venueNameFromDescription(fieldString(fields, ["Description"])) ??
    displayVenueField(fields, ["Venue__c", "Facility__c", "Location__c", "Theater__c", "Theatre__c"]) ??
    "TDF";
  const productionSeasonId = fieldString(fields, ["ProductionSeasonId__c", "Production_Season_Id__c"]) ?? title;
  const performanceId = fieldString(fields, ["PerformanceId__c", "Performance_Id__c"]) ?? id;
  const performanceDate =
    fieldString(fields, ["Performance_Date__c", "PerformanceDate__c", "Start_Date__c", "StartDate__c", "Event_Date__c"]) ??
    "Date unavailable";

  return {
    productionSeasonId,
    title,
    facility,
    keywords: [],
    thumbnail: storefrontImageUrl(product["defaultImage"]) ?? "",
    performances: [{ performanceId, performanceDate }],
    isTAP: false,
    isNew: false,
    promotions: []
  };
}

function offersFromStorefrontProducts(products: Array<Record<string, unknown>>): TdfOffer[] {
  const grouped = new Map<string, TdfOffer>();
  products.forEach((product, index) => {
    const offer = offerFromStorefrontProduct(product, index);
    if (!offer) {
      return;
    }
    const key = storefrontGroupKey(product, offer);
    const existing = grouped.get(key);
    if (existing) {
      existing.performances.push(...offer.performances);
      if (!existing.thumbnail && offer.thumbnail) {
        existing.thumbnail = offer.thumbnail;
      }
      return;
    }
    grouped.set(key, offer);
  });
  return Array.from(grouped.values());
}

function storefrontGroupKey(product: Record<string, unknown>, offer: TdfOffer): string {
  const fields = isRecord(product["fields"]) ? product["fields"] : {};
  const productionSeasonId = fieldString(fields, ["ProductionSeasonId__c", "Production_Season_Id__c"]);
  if (productionSeasonId) {
    return `season:${productionSeasonId}`;
  }
  return `show:${normalizedKeyPart(offer.title)}:${normalizedKeyPart(offer.facility)}`;
}

function normalizedKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function venueNameFromDescription(description: string | undefined): string | undefined {
  if (!description) {
    return undefined;
  }
  const match = description.match(/<span\b[^>]*(?:id|class)=["']venue_name["'][^>]*>(.*?)<\/span>/is);
  return match?.[1] ? normalizeHtmlText(match[1]) : undefined;
}

function displayVenueField(fields: Record<string, unknown>, candidates: string[]): string | undefined {
  const value = fieldString(fields, candidates);
  if (!value || /^001[A-Za-z0-9]{12,}$/.test(value)) {
    return undefined;
  }
  return value;
}

function normalizeHtmlText(value: string): string | undefined {
  const text = value
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&mdash;/gi, "-")
    .replace(/&ndash;/gi, "-")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

function fieldString(fields: Record<string, unknown>, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const value = stringValue(fields[candidate]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function storefrontImageUrl(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const url = stringValue(value["url"]) ?? stringValue(value["thumbnailUrl"]);
  if (!url || url.includes("/default-product-image.svg")) {
    return undefined;
  }
  return url.startsWith("/") ? `https://members.tdf.org${url}` : url;
}
