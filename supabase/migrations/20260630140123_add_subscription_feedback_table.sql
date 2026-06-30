-- subscription_feedback: stores optional cancellation survey responses
CREATE TABLE IF NOT EXISTS subscription_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES user_profiles(id) ON DELETE CASCADE,
  what_didnt_work text,
  what_liked text,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE subscription_feedback ENABLE ROW LEVEL SECURITY;

-- Users can only insert their own feedback
CREATE POLICY "insert_own_feedback" ON subscription_feedback FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

-- Users can read their own feedback
CREATE POLICY "select_own_feedback" ON subscription_feedback FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

-- No update or delete for users — feedback is append-only
