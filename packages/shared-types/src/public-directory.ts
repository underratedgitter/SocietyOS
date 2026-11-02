export interface PublicSocietySummary {
  id: string;
  name: string;
  slug: string;
  timezone: string;
}

export interface PublicFlatSummary {
  id: string;
  buildingId: string;
  buildingName: string;
  flatNumber: string;
  label: string;
}
