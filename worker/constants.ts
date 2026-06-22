export const cookieKey = "TDF_COOKIE";
export const cookieMetaKey = "TDF_COOKIE_META";
export const seenKey = "SEEN_OFFERS";
export const authStateKey = "AUTH_STATE";
export const healthStateKey = "HEALTH_STATE";
export const deltaLockKey = "DELTA_LOCK";
export const workerVersion = "2026-06-22.salesforce-commerce-v3";
export const tdfMemberHomeUrl = "https://members.tdf.org/store/";
export const tdfOffersUrl = "https://members.tdf.org/store/";
const tdfWebstoreId = "0ZEfK000000qcIvWAI";
export const tdfPerformancesCategoryId = "0ZGPe0000000AtpOAE";
export const tdfApiBaseUrl =
  `https://members.tdf.org/store/webruntime/api/services/data/v67.0/commerce/webstores/${tdfWebstoreId}`;
export const tdfApexExecuteUrl =
  "https://members.tdf.org/store/webruntime/api/apex/execute?language=en-US&asGuest=false&htmlEncode=false";
export const tdfCsrfTokenModuleUrl = "https://members.tdf.org/store/webruntime/module/@app/csrfToken";
export const tdfProductionAvailabilityClassName = "@udd/01pPe000002Vwl5";
export const tdfTicketBookingClassName = "@udd/01pPe000001jpVz";
export const tdfSessionContextUrl =
  `${tdfApiBaseUrl}/session-context?language=en-US&asGuest=false&htmlEncode=false`;
export const tdfProductFields = [
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
  "Performance_Id__c",
  "Venue_Name__c",
  "Is_New__c"
].join(",");
export const authFailureNotifyIntervalMs = 12 * 60 * 60 * 1000;
export const browserbaseRefreshAttemptIntervalMs = 6 * 60 * 60 * 1000;
export const browserbaseDispatchFailureRetryMs = 30 * 60 * 1000;
export const staleSuccessAlertAfterMs = 30 * 60 * 1000;
export const deltaLockTtlMs = 8 * 60 * 1000;
export const cookieRefreshPersistIntervalMs = 60 * 60 * 1000;
export const healthStateWriteIntervalMs = 20 * 60 * 1000;
export const runLogSchemaVersion = 1;
