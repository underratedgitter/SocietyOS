export interface PublicSocietySummary {
  id: string;
  name: string;
  slug: string;
  city?: string | null;
}

export interface PublicFlatSummary {
  id: string;
  buildingId: string;
  buildingName: string;
  flatNumber: string;
  label: string;
}
