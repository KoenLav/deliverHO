-- deliverHO -- Postgres schema.
--
-- Read docs/data-protection.md before changing anything here. This database
-- holds AVG Article 9 special-category data: the fact that a named person does
-- sex work concerns their sex life, and a breach of it is not recoverable by
-- apology or compensation. Several columns below are deliberately absent, and
-- the comments say which and why.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Operators
-- ---------------------------------------------------------------------------

CREATE TABLE operators (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name            text        NOT NULL,
  kvk_number            text        NOT NULL,
  vergunning_number     text        NOT NULL,
  municipality          text        NOT NULL,
  vergunning_valid_from timestamptz NOT NULL,
  vergunning_valid_until timestamptz NOT NULL,
  suspended_at          timestamptz,
  beheerder_name        text        NOT NULL,
  contact_phone         text        NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vergunning_window CHECK (vergunning_valid_until > vergunning_valid_from)
);

-- ---------------------------------------------------------------------------
-- Workers
-- ---------------------------------------------------------------------------

CREATE TYPE worker_status AS ENUM (
  'pending_verification', 'active', 'paused_by_worker',
  'suspended_by_operator', 'offboarded'
);

CREATE TABLE workers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   uuid NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  display_name  text NOT NULL,         -- Working name only. Never the legal name.
  status        worker_status NOT NULL DEFAULT 'pending_verification',
  direct_phone  text NOT NULL,
  payout_iban   text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Both of these back the strongest coercion indicators we have, and both are
  -- enforced at the database rather than only in application code: a UNIQUE
  -- constraint cannot be forgotten by a future code path.
  CONSTRAINT worker_direct_phone_unique UNIQUE (direct_phone),
  CONSTRAINT worker_payout_iban_unique  UNIQUE (payout_iban)
);

-- Identity verification is a separate table with separate grants, so ordinary
-- booking queries never touch date of birth. There is deliberately NO column
-- for a scan or photograph of the identity document: we check it, record that
-- we checked it, and do not keep it.
CREATE TABLE worker_identity_verifications (
  worker_id                uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  method                   text        NOT NULL,
  verified_at              timestamptz NOT NULL,
  verified_by              text        NOT NULL,
  date_of_birth            date        NOT NULL,
  right_to_work_confirmed  boolean     NOT NULL,
  document_reference_hash  text        NOT NULL
);

CREATE TABLE worker_intake_interviews (
  worker_id                        uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  conducted_at                     timestamptz NOT NULL,
  conducted_by                     text        NOT NULL,
  language                         text        NOT NULL,
  conducted_alone                  boolean     NOT NULL,
  exit_programme_information_given boolean     NOT NULL,
  concerns                         text
);

CREATE TABLE worker_boundaries (
  worker_id             uuid PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  refused_services      text[]  NOT NULL DEFAULT '{}',
  earliest_start_hour   smallint NOT NULL CHECK (earliest_start_hour BETWEEN 0 AND 23),
  latest_start_hour     smallint NOT NULL CHECK (latest_start_hour BETWEEN 0 AND 23),
  max_booking_minutes   integer  NOT NULL CHECK (max_booking_minutes > 0),
  allowed_location_types text[]  NOT NULL DEFAULT '{}'
);

CREATE TABLE worker_municipalities (
  worker_id    uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  municipality text NOT NULL,
  PRIMARY KEY (worker_id, municipality)
);

-- ---------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------

CREATE TABLE clients (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_level  text        NOT NULL,
  phone_verified_at   timestamptz,
  idin_verified_at    timestamptz,
  blocked_at          timestamptz,
  blocked_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Availability
-- ---------------------------------------------------------------------------

CREATE TABLE availability_windows (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  municipality text NOT NULL,
  withdrawn_at timestamptz,
  CONSTRAINT availability_window_order CHECK (ends_at > starts_at)
);

CREATE INDEX availability_lookup
  ON availability_windows (worker_id, starts_at, ends_at)
  WHERE withdrawn_at IS NULL;

-- ---------------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------------

CREATE TYPE booking_status AS ENUM (
  'requested', 'screening', 'offered', 'accepted', 'confirmed',
  'en_route', 'in_progress', 'completed', 'declined_by_worker',
  'cancelled_by_worker', 'cancelled_by_client', 'blocked_by_compliance', 'expired'
);

CREATE TABLE bookings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id        uuid NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  client_id          uuid NOT NULL REFERENCES clients(id)   ON DELETE RESTRICT,
  -- Nullable on purpose: a booking has no worker until one accepts it.
  worker_id          uuid REFERENCES workers(id) ON DELETE RESTRICT,
  status             booking_status NOT NULL DEFAULT 'requested',
  requested_start    timestamptz NOT NULL,
  duration_minutes   integer NOT NULL CHECK (duration_minutes > 0),
  location_type      text NOT NULL,
  municipality       text NOT NULL,
  address_line       text NOT NULL,
  postal_code        text NOT NULL,
  venue_name         text,
  requested_services text[] NOT NULL DEFAULT '{}',
  agreed_rate_cents  integer NOT NULL CHECK (agreed_rate_cents > 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  redacted_at        timestamptz,

  -- A booking past the offer stage must have a worker. This is the database's
  -- restatement of "no work happens without someone accepting it".
  CONSTRAINT worker_required_after_acceptance CHECK (
    status IN ('requested','screening','offered','blocked_by_compliance','expired',
               'declined_by_worker','cancelled_by_client')
    OR worker_id IS NOT NULL
  )
);

CREATE INDEX bookings_by_worker   ON bookings (worker_id, requested_start DESC);
CREATE INDEX bookings_by_operator ON bookings (operator_id, requested_start DESC);
CREATE INDEX bookings_due_for_redaction ON bookings (created_at) WHERE redacted_at IS NULL;

-- Append-only. Enforced by grant: the application role gets INSERT and SELECT
-- and never UPDATE or DELETE, so the audit trail the gemeente may ask for
-- cannot be quietly rewritten by the operator it describes.
CREATE TABLE booking_events (
  id         bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  status     booking_status NOT NULL,
  actor_kind text NOT NULL,
  actor_id   uuid,
  reason     text
);

CREATE INDEX booking_events_by_booking ON booking_events (booking_id, at);

-- ---------------------------------------------------------------------------
-- Safety
-- ---------------------------------------------------------------------------

CREATE TYPE safety_session_state AS ENUM ('open', 'checked_in', 'closed', 'escalated');

CREATE TABLE safety_sessions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id            uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  worker_id             uuid NOT NULL REFERENCES workers(id)  ON DELETE CASCADE,
  state                 safety_session_state NOT NULL DEFAULT 'open',
  opened_at             timestamptz NOT NULL DEFAULT now(),
  checked_in_at         timestamptz,
  expected_check_out_at timestamptz NOT NULL,
  closed_at             timestamptz,
  escalated_at          timestamptz,
  escalation_reason     text
);

-- The sweep runs against this index every minute. It must stay fast: the whole
-- safety model rests on an overdue session being noticed promptly.
CREATE INDEX safety_sessions_due
  ON safety_sessions (expected_check_out_at)
  WHERE state IN ('open', 'checked_in');

CREATE TABLE safety_escalation_contacts (
  id         bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES safety_sessions(id) ON DELETE CASCADE,
  name       text NOT NULL,
  phone      text NOT NULL,
  "order"    integer NOT NULL,
  kind       text NOT NULL
);

-- ---------------------------------------------------------------------------
-- Administration (tier 1: survives redaction)
-- ---------------------------------------------------------------------------

-- What an inspection actually gets. No names, no addresses, no client. The
-- pseudonym is an HMAC whose key lives outside the database, so a
-- database-only breach does not re-link these rows to people.
CREATE TABLE administration_records (
  booking_id        uuid PRIMARY KEY REFERENCES bookings(id) ON DELETE RESTRICT,
  vergunning_number text NOT NULL,
  municipality      text NOT NULL,
  worker_pseudonym  text NOT NULL,
  booking_date      date NOT NULL,
  duration_minutes  integer NOT NULL,
  status            text NOT NULL,
  completed_at      timestamptz
);

CREATE INDEX administration_by_date ON administration_records (booking_date);

-- ---------------------------------------------------------------------------
-- Risk
-- ---------------------------------------------------------------------------

CREATE TABLE account_accesses (
  id                 bigserial PRIMARY KEY,
  worker_id          uuid NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  device_fingerprint text NOT NULL,
  at                 timestamptz NOT NULL DEFAULT now()
  -- No ip_address column. It would add little to the device fingerprint for
  -- detection purposes and a great deal to what a breach or a subpoena reveals
  -- about where a worker sleeps.
);

CREATE INDEX accesses_by_device ON account_accesses (device_fingerprint, at DESC);

CREATE TABLE risk_signals (
  id          bigserial PRIMARY KEY,
  code        text NOT NULL,
  severity    text NOT NULL CHECK (severity IN ('info', 'review', 'block')),
  message     text NOT NULL,
  subject_kind text NOT NULL,
  subject_id  uuid NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  -- Cleared by a named human, never by a job.
  reviewed_at timestamptz,
  reviewed_by text,
  review_note text
);

CREATE INDEX risk_signals_open
  ON risk_signals (subject_id, detected_at DESC)
  WHERE reviewed_at IS NULL;
