export interface Database {
  public: {
    Tables: {
      parcels: {
        Row: Parcel;
        Insert: Omit<Parcel, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<Parcel, 'id'>>;
      };
      reports: {
        Row: Report;
        Insert: Omit<Report, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<Report, 'id'>>;
      };
      soil_results: {
        Row: SoilResult;
        Insert: Omit<SoilResult, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<SoilResult, 'id'>>;
      };
      county_rules: {
        Row: CountyRule;
        Insert: Omit<CountyRule, 'id'> & { id?: string };
        Update: Partial<Omit<CountyRule, 'id'>>;
      };
      nearby_tests: {
        Row: NearbyTest;
        Insert: Omit<NearbyTest, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<NearbyTest, 'id'>>;
      };
    };
  };
}

export interface Parcel {
  id: string;
  user_id: string | null;
  address: string | null;
  apn: string | null;
  lat: number | null;
  lng: number | null;
  state: string | null;
  county: string | null;
  boundary_geojson: Record<string, unknown> | null;
  boundary_source: string | null;
  acreage: number | null;
  owner: string | null;
  created_at: string;
}

export interface Report {
  id: string;
  user_id: string;
  parcel_id: string;
  conventional_score: number | null;
  alternative_score: number | null;
  best_zone_score: number | null;
  parcel_score: number | null;
  confidence: number | null;
  data_depth_tier: 1 | 2 | 3 | 4 | null;
  data_depth_note: string | null;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  fema_feature_count: number | null;
  nwi_feature_count: number | null;
  report_data: Record<string, unknown> | null;
  overlay_geojson: { femaFeatures: unknown[]; nwiFeatures: unknown[] } | null;
  created_at: string;
  parcels?: Parcel;
  soil_results?: SoilResult[];
}

export interface SoilResult {
  id: string;
  report_id: string;
  map_unit_key: string | null;
  map_unit_name: string | null;
  texture_class: string | null;
  drainage_class: string | null;
  perc_class: string | null;
  nrcs_septic_rating: string | null;
  depth_water_table: number | null;
  ksat_low: number | null;
  ksat_r: number | null;
  ksat_high: number | null;
  slope_low: number | null;
  slope_high: number | null;
  pct_coverage: number | null;
  raw_ssurgo: Record<string, unknown> | null;
  soil_polygon_geojson: Record<string, unknown> | null;
  created_at: string;
}

export interface CountyRule {
  id: string;
  state: string | null;
  county: string | null;
  min_lot_size_acres: number | null;
  setback_well_ft: number | null;
  setback_property_line_ft: number | null;
  setback_water_ft: number | null;
  alt_systems_allowed: boolean | null;
  notes: string | null;
  last_updated: string | null;
}

export interface UserProfile {
  id: string;
  first_name: string;
  last_name: string;
  phone: string;
  organization: string;
  billing_address_1: string;
  billing_address_2: string;
  billing_city: string;
  billing_state: string;
  billing_postal_code: string;
  billing_country: string;
  plan: 'free' | 'starter' | 'pro' | 'unlimited';
  plan_status: string;
  subscription_status: string | null;
  plan_renewal_date: string | null;
  stripe_customer_id: string | null;
  monthly_analyses_used: number;
  analyses_reset_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PlanTier = 'free' | 'starter' | 'pro' | 'unlimited';

export const PLAN_LIMITS: Record<PlanTier, number | null> = {
  free: 3,
  starter: 15,
  pro: 50,
  unlimited: null,
};

export interface NearbyTest {
  id: string;
  county: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  outcome: string | null;
  system_type: string | null;
  map_unit_key: string | null;
  test_year: number | null;
  source: string | null;
  verified: boolean | null;
  created_at: string;
}
