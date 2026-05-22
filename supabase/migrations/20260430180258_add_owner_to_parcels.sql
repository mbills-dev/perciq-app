/*
  # Add owner field to parcels table

  Adds an `owner` text column to store the parcel owner name
  returned by the Regrid API lookup.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'parcels'
      AND column_name  = 'owner'
  ) THEN
    ALTER TABLE parcels ADD COLUMN owner text;
  END IF;
END $$;
