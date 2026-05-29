/*
  # Add Stripe billing fields to user_profiles

  1. Changes to user_profiles table
    - `stripe_customer_id` (text) — Stripe customer ID for this user
    - `subscription_status` (text, default 'inactive') — active, inactive, trialing, past_due, canceled
    - Rename plan column values to lowercase: free/starter/pro/unlimited
    - `plan` default changed to 'free'
    - `plan_renewal_date` already exists; kept as-is

  2. Also adds a `monthly_analyses_used` counter and `analyses_reset_at` for usage tracking

  3. Security: RLS unchanged (users can only read/update their own row)
*/

-- Add stripe_customer_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'stripe_customer_id'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN stripe_customer_id text DEFAULT NULL;
  END IF;
END $$;

-- Add subscription_status
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'subscription_status'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN subscription_status text DEFAULT 'inactive';
  END IF;
END $$;

-- Add monthly_analyses_used
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'monthly_analyses_used'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN monthly_analyses_used integer DEFAULT 0;
  END IF;
END $$;

-- Add analyses_reset_at (tracks when the monthly counter was last reset)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_profiles' AND column_name = 'analyses_reset_at'
  ) THEN
    ALTER TABLE user_profiles ADD COLUMN analyses_reset_at timestamptz DEFAULT now();
  END IF;
END $$;

-- Normalise existing plan values to lowercase
UPDATE user_profiles SET plan = lower(plan) WHERE plan IS NOT NULL;

-- Set default for plan to 'free'
ALTER TABLE user_profiles ALTER COLUMN plan SET DEFAULT 'free';
