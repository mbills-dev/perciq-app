-- Public read: anyone can view report map images
CREATE POLICY "public read report maps"
ON storage.objects FOR SELECT
TO anon, authenticated
USING (bucket_id = 'report-maps');

-- Authenticated write: only authenticated users can upload/upsert their own report maps
CREATE POLICY "authenticated upload report maps"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'report-maps');

-- Authenticated update: allow upsert (needed for re-runs)
CREATE POLICY "authenticated update report maps"
ON storage.objects FOR UPDATE
TO authenticated
USING (bucket_id = 'report-maps')
WITH CHECK (bucket_id = 'report-maps');