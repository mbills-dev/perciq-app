/*
  # Create user_profiles table

  1. New Tables
    - `user_profiles`
      - `id` (uuid, primary key, references auth.users)
      - `first_name` (text)
      - `last_name` (text)
      - `phone` (text)
      - `organization` (text)
      - `billing_address_1` (text)
      - `billing_address_2` (text)
      - `billing_city` (text)
      - `billing_state` (text)
      - `billing_postal_code` (text)
      - `billing_country` (text, default 'US')
      - `plan` (text, default 'Free')
      - `plan_status` (text, default 'Active')
      - `plan_renewal_date` (date)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Security
    - Enable RLS
    - Users can read and update only their own profile
    - Insert policy for new profile creation
*/

CREATE TABLE IF NOT EXISTS user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  first_name text DEFAULT '',
  last_name text DEFAULT '',
  phone text DEFAULT '',
  organization text DEFAULT '',
  billing_address_1 text DEFAULT '',
  billing_address_2 text DEFAULT '',
  billing_city text DEFAULT '',
  billing_state text DEFAULT '',
  billing_postal_code text DEFAULT '',
  billing_country text DEFAULT 'US',
  plan text DEFAULT 'Free',
  plan_status text DEFAULT 'Active',
  plan_renewal_date date,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own profile"
  ON user_profiles FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON user_profiles FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON user_profiles FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);
