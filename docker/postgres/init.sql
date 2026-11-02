-- dient sample data for PostgreSQL.
--
-- A fictional B2B support platform ("Northstar") rather than a toy shop:
-- customer companies, contacts, subscriptions, invoices, payments, support
-- tickets, projects, tasks, usage, audit history, and analytics.
--
-- IDs are UUIDs or human-readable business keys, not 1/2/3. The data is
-- deterministic so demos and screenshots stay stable across reseeds.
--
-- Seeded via /docker-entrypoint-initdb.d: it runs only on a fresh volume.
-- Reset with `docker compose down -v`.

\set ON_ERROR_STOP on

-- Deterministic UUIDs make related inserts readable without a spreadsheet of
-- literal IDs. The helper is dropped after seeding; it is not part of the app.
CREATE OR REPLACE FUNCTION demo_uuid(seed text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT (
    substr(h, 1, 8) || '-' ||
    substr(h, 9, 4) || '-' ||
    '4' || substr(h, 14, 3) || '-' ||
    '8' || substr(h, 18, 3) || '-' ||
    substr(h, 21, 12)
  )::uuid
  FROM (SELECT md5(seed) AS h) AS digest
$$;

-- Small deterministic range helper for values that should not march in lockstep
-- (headcount, revenue, seats, and similar demo numbers).
CREATE OR REPLACE FUNCTION demo_between(seed text, low integer, high integer) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT low + (('x' || substr(md5(seed), 1, 7))::bit(28)::int % (high - low + 1))
$$;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'canceled', 'paused');
CREATE TYPE invoice_status AS ENUM ('draft', 'open', 'paid', 'void', 'uncollectible');
CREATE TYPE payment_status AS ENUM ('pending', 'succeeded', 'failed', 'refunded');
CREATE TYPE ticket_priority AS ENUM ('low', 'normal', 'high', 'urgent');
CREATE TYPE ticket_status AS ENUM ('new', 'open', 'pending', 'resolved', 'closed');
CREATE TYPE ticket_channel AS ENUM ('email', 'chat', 'phone', 'web', 'api');
CREATE TYPE author_type AS ENUM ('customer', 'agent', 'system');
CREATE TYPE project_status AS ENUM ('planned', 'active', 'paused', 'completed', 'canceled');
CREATE TYPE task_status AS ENUM ('backlog', 'todo', 'in_progress', 'blocked', 'review', 'done');
CREATE TYPE experiment_status AS ENUM ('draft', 'running', 'paused', 'completed');
CREATE TYPE notification_channel AS ENUM ('email', 'in_app', 'slack', 'webhook');
CREATE TYPE impact_level AS ENUM ('none', 'minor', 'major', 'critical');
CREATE TYPE incident_severity AS ENUM ('sev1', 'sev2', 'sev3', 'sev4');
CREATE TYPE incident_status AS ENUM ('investigating', 'identified', 'monitoring', 'resolved');

CREATE TABLE countries (
  country_code char(2) PRIMARY KEY,
  name text NOT NULL,
  region text NOT NULL,
  currency char(3) NOT NULL,
  tax_rate numeric(5, 4) NOT NULL DEFAULT 0
);

INSERT INTO countries (country_code, name, region, currency, tax_rate) VALUES
  ('US', 'United States', 'Americas', 'USD', 0.0800),
  ('CA', 'Canada', 'Americas', 'CAD', 0.0500),
  ('GB', 'United Kingdom', 'Europe', 'GBP', 0.2000),
  ('DE', 'Germany', 'Europe', 'EUR', 0.1900),
  ('FR', 'France', 'Europe', 'EUR', 0.2000),
  ('NL', 'Netherlands', 'Europe', 'EUR', 0.2100),
  ('SE', 'Sweden', 'Europe', 'SEK', 0.2500),
  ('AU', 'Australia', 'Asia Pacific', 'AUD', 0.1000),
  ('JP', 'Japan', 'Asia Pacific', 'JPY', 0.1000),
  ('SG', 'Singapore', 'Asia Pacific', 'SGD', 0.0900),
  ('IN', 'India', 'Asia Pacific', 'INR', 0.1800),
  ('BR', 'Brazil', 'Americas', 'BRL', 0.1700);

CREATE TABLE plans (
  plan_code text PRIMARY KEY CHECK (plan_code ~ '^[a-z][a-z0-9_]+$'),
  name text NOT NULL,
  monthly_price numeric(10, 2) NOT NULL,
  annual_price numeric(10, 2) NOT NULL,
  seat_limit integer,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true
);

INSERT INTO plans (plan_code, name, monthly_price, annual_price, seat_limit, features, active) VALUES
  ('starter', 'Starter', 29.00, 290.00, 10,
   '{"sso": false, "audit_log": false, "api_calls": 50000, "support": "email"}'::jsonb, true),
  ('growth', 'Growth', 79.00, 790.00, 50,
   '{"sso": true, "audit_log": true, "api_calls": 500000, "support": "business_hours"}'::jsonb, true),
  ('scale', 'Scale', 189.00, 1890.00, 250,
   '{"sso": true, "audit_log": true, "api_calls": 5000000, "support": "24x7"}'::jsonb, true),
  ('enterprise', 'Enterprise', 499.00, 4990.00, NULL,
   '{"sso": true, "audit_log": true, "api_calls": 50000000, "support": "dedicated_csm"}'::jsonb, true),
  ('legacy_plus', 'Legacy Plus', 149.00, 1490.00, 100,
   '{"sso": true, "audit_log": false, "api_calls": 1000000, "support": "business_hours"}'::jsonb, false);

CREATE TABLE staff (
  staff_id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  full_name text NOT NULL,
  job_title text NOT NULL,
  department text NOT NULL,
  manager_id uuid REFERENCES staff(staff_id),
  hired_on date NOT NULL,
  timezone text NOT NULL,
  skills text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb
);

WITH people AS (
  SELECT
    n,
    (ARRAY[
      'Maya Chen', 'Jonas Weber', 'Priya Raman', 'Lucas Moreau',
      'Sofia Alvarez', 'Noah Williams', 'Amara Okafor', 'Elena Rossi',
      'Hiro Tanaka', 'Nadia Petrova', 'Owen Gallagher', 'Leila Haddad'
    ])[n] AS full_name,
    (ARRAY[
      'Support Lead', 'Senior Support Engineer', 'Billing Specialist',
      'Customer Success Manager', 'Solutions Architect', 'Platform Engineer',
      'Incident Commander', 'Data Analyst', 'Implementation Manager',
      'Security Engineer', 'Account Executive', 'Technical Writer'
    ])[n] AS job_title,
    (ARRAY[
      'Customer Support', 'Customer Support', 'Finance',
      'Customer Success', 'Solutions Engineering', 'Platform Engineering',
      'Reliability', 'Data', 'Professional Services',
      'Security', 'Sales', 'Product'
    ])[n] AS department,
    (ARRAY[
      'America/Los_Angeles', 'Europe/Berlin', 'Asia/Kolkata',
      'Europe/Paris', 'America/New_York', 'America/Chicago',
      'Africa/Lagos', 'Europe/Rome', 'Asia/Tokyo',
      'Europe/Warsaw', 'America/Denver', 'Asia/Dubai'
    ])[n] AS timezone,
    CASE n
      WHEN 1 THEN ARRAY['sql', 'customer-research']
      WHEN 2 THEN ARRAY['postgres', 'performance']
      WHEN 3 THEN ARRAY['billing', 'stripe']
      WHEN 4 THEN ARRAY['onboarding', 'training']
      WHEN 5 THEN ARRAY['kubernetes', 'terraform']
      WHEN 6 THEN ARRAY['typescript', 'api']
      WHEN 7 THEN ARRAY['incident-response', 'observability']
      WHEN 8 THEN ARRAY['analytics', 'dbt']
      WHEN 9 THEN ARRAY['implementation', 'migrations']
      WHEN 10 THEN ARRAY['soc2', 'appsec']
      WHEN 11 THEN ARRAY['negotiation', 'forecasting']
      ELSE ARRAY['documentation', 'dx']
    END AS skills,
    (ARRAY['she/her', 'he/him', 'she/her', 'he/him', 'she/her', 'he/him',
           'she/her', 'she/her', 'he/him', 'she/her', 'he/him', 'she/her'])[n] AS pronouns
  FROM generate_series(1, 12) AS n
)
INSERT INTO staff (staff_id, email, full_name, job_title, department, manager_id, hired_on, timezone, skills, active, profile)
SELECT
  demo_uuid('staff-' || n),
  lower(replace(full_name, ' ', '.')) || '@northstar.example',
  full_name,
  job_title,
  department,
  CASE WHEN n IN (1, 5, 9) THEN NULL ELSE demo_uuid('staff-' || (n - 1)) END,
  DATE '2021-03-15' + (n * 47),
  timezone,
  skills,
  n <> 12,
  jsonb_build_object(
    'pronouns', pronouns,
    'slack', '@' || lower(split_part(full_name, ' ', 1)),
    'location', (ARRAY['Portland', 'Berlin', 'Bengaluru', 'Paris', 'New York', 'Chicago',
                       'Lagos', 'Rome', 'Tokyo', 'Warsaw', 'Denver', 'Dubai'])[n]
  )
FROM people;

CREATE TABLE customers (
  customer_id uuid PRIMARY KEY,
  external_id text NOT NULL UNIQUE,
  name text NOT NULL,
  domain text NOT NULL UNIQUE,
  industry text NOT NULL,
  employee_count integer NOT NULL CHECK (employee_count > 0),
  annual_revenue numeric(14, 2) NOT NULL CHECK (annual_revenue >= 0),
  health_score smallint NOT NULL CHECK (health_score BETWEEN 0 AND 100),
  owner_id uuid NOT NULL REFERENCES staff(staff_id),
  tags text[] NOT NULL DEFAULT '{}',
  billing_address jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

WITH companies AS (
  SELECT
    n,
    (ARRAY[
      'Northwind Logistics', 'Brightline Labs', 'Harborview Health',
      'Cedar and Pine Legal', 'Summit Ridge Financial', 'Blue Oak Capital',
      'Redwood Media Group', 'Atlas Manufacturing', 'Beacon Education',
      'Orbit Robotics', 'Tidewater Energy', 'Granite Peak Insurance',
      'Willow Creek Foods', 'Mosaic Retail Partners', 'Pioneer AgTech',
      'Silverline Airlines', 'Copperfield Studios', 'Meridian Biotech',
      'Ironwood Construction', 'Lakeshore Hospitality', 'Kestrel Analytics',
      'Juniper Public Sector', 'Solstice Solar', 'Alder and Finch',
      'Bluebird Pediatrics', 'Clearwater Utilities', 'Driftwood Hotels',
      'Everest Outdoor', 'Fieldstone Bank', 'Greenway Transit',
      'Highline Architecture', 'Inlet Software', 'Jade Harbor Shipping',
      'Keystone Fabrication', 'Lantern Health', 'Maple Grove Schools',
      'Nightingale Hospice', 'Opal Insurance', 'Prairie Wind Farms',
      'Quarry Lane Mining'
    ])[n] AS name,
    (ARRAY['Technology', 'Healthcare', 'Legal', 'Financial Services', 'Media',
           'Manufacturing', 'Education', 'Robotics', 'Energy', 'Insurance'])[((n - 1) % 10) + 1] AS industry,
    (ARRAY['Portland', 'Austin', 'Boston', 'Denver', 'Seattle', 'Chicago',
           'Atlanta', 'San Diego', 'Minneapolis', 'Raleigh', 'Nashville',
           'Salt Lake City', 'Pittsburgh', 'Columbus', 'Kansas City', 'Charlotte'])[((n - 1) % 16) + 1] AS city,
    (ARRAY['OR', 'TX', 'MA', 'CO', 'WA', 'IL', 'GA', 'CA', 'MN', 'NC',
           'TN', 'UT', 'PA', 'OH', 'MO', 'NC'])[((n - 1) % 16) + 1] AS region,
    (ARRAY['97205', '78701', '02110', '80202', '98101', '60606',
           '30308', '92101', '55401', '27601', '37203', '84101',
           '15222', '43215', '64106', '28202'])[((n - 1) % 16) + 1] AS postal_code
  FROM generate_series(1, 40) AS n
)
INSERT INTO customers (customer_id, external_id, name, domain, industry, employee_count, annual_revenue, health_score, owner_id, tags, billing_address, created_at, updated_at)
SELECT
  demo_uuid('customer-' || n),
  'cus_' || lpad(n::text, 5, '0'),
  name,
  lower(regexp_replace(name, '[^A-Za-z0-9]+', '-', 'g')) || '.com',
  industry,
  35 + (n * 137) % 4800,
  round((250000 + (n * 9173) % 9000000)::numeric, 2),
  45 + (n * 7) % 56,
  demo_uuid('staff-' || ((n % 12) + 1)),
  ARRAY[
    (ARRAY['strategic', 'mid-market', 'smb', 'partner'])[((n - 1) % 4) + 1],
    (ARRAY['high-touch', 'self-serve'])[((n - 1) % 2) + 1]
  ],
  jsonb_build_object(
    'line1', (100 + n) || ' ' || (ARRAY['Market St', 'Congress Ave', 'Seaport Blvd', 'Larimer St'])[((n - 1) % 4) + 1],
    'city', city,
    'region', region,
    'postal_code', postal_code,
    'country', 'US'
  ),
  now() - ((n * 11) || ' days')::interval,
  now() - ((n * 3) || ' hours')::interval
FROM companies;

CREATE TABLE contacts (
  contact_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  phone text,
  job_title text NOT NULL,
  timezone text NOT NULL,
  locale text NOT NULL,
  opted_in boolean NOT NULL DEFAULT false,
  last_contacted_at timestamptz,
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb
);

WITH customer_rows AS (
  SELECT row_number() OVER (ORDER BY external_id) AS rn, domain
  FROM customers
),
people AS (
  SELECT
    n,
    ((n - 1) / 3) + 1 AS customer_rn,
    (ARRAY[
      'Avery', 'Jordan', 'Riley', 'Cameron', 'Morgan', 'Casey', 'Taylor', 'Quinn',
      'Reese', 'Drew', 'Parker', 'Hayden', 'Rowan', 'Emerson', 'Finley', 'Sage',
      'Blake', 'Dakota', 'Skyler', 'Alex'
    ])[((n - 1) % 20) + 1] AS first_name,
    (ARRAY[
      'Nguyen', 'Patel', 'Garcia', 'Kim', 'Andersson', 'Okafor', 'Silva', 'Cohen',
      'Martinez', 'Bennett', 'Fischer', 'Rossi', 'Tanaka', 'Dubois', 'Kowalski',
      'Hassan', 'Murphy', 'Reed', 'Santos', 'Ivanov'
    ])[((n * 7) % 20) + 1] AS last_name,
    (ARRAY[
      'VP Operations', 'Director of IT', 'Finance Manager', 'Support Manager',
      'Head of Customer Experience', 'Security Lead', 'Data Engineer',
      'Procurement Manager', 'COO', 'IT Administrator', 'Product Manager',
      'Compliance Officer', 'Engineering Manager', 'Billing Analyst', 'CEO'
    ])[((n - 1) % 15) + 1] AS job_title,
    (ARRAY[
      'America/Los_Angeles', 'America/New_York', 'America/Chicago',
      'Europe/London', 'Europe/Berlin', 'Asia/Singapore', 'Asia/Tokyo', 'UTC'
    ])[((n - 1) % 8) + 1] AS timezone
  FROM generate_series(1, 120) AS n
)
INSERT INTO contacts (contact_id, customer_id, first_name, last_name, email, phone, job_title, timezone, locale, opted_in, last_contacted_at, custom_fields)
SELECT
  demo_uuid('contact-' || n),
  demo_uuid('customer-' || customer_rn),
  first_name,
  last_name,
  lower(first_name || '.' || last_name || n) || '@' || customer_rows.domain,
  '+1-415-555-' || lpad((1000 + n)::text, 4, '0'),
  job_title,
  timezone,
  (ARRAY['en-US', 'en-GB', 'de-DE', 'fr-FR'])[((n - 1) % 4) + 1],
  n % 5 <> 0,
  now() - (((n * 5) % 120) || ' hours')::interval,
  jsonb_build_object(
    'linkedin', 'https://www.linkedin.com/in/' || lower(first_name || '-' || last_name || n),
    'preferred_channel', (ARRAY['email', 'phone', 'chat'])[((n - 1) % 3) + 1]
  )
FROM people
JOIN customer_rows ON customer_rows.rn = people.customer_rn;

CREATE TABLE subscriptions (
  subscription_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  plan_code text NOT NULL REFERENCES plans(plan_code),
  status subscription_status NOT NULL,
  seats integer NOT NULL CHECK (seats > 0),
  mrr numeric(12, 2) NOT NULL CHECK (mrr >= 0),
  currency char(3) NOT NULL DEFAULT 'USD',
  current_period tstzrange NOT NULL,
  trial_ends_at timestamptz,
  canceled_at timestamptz,
  discount jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

WITH base AS (
  SELECT
    n,
    (ARRAY['starter', 'growth', 'scale', 'enterprise', 'growth'])[((n - 1) % 5) + 1] AS plan_code,
    (ARRAY['active', 'active', 'active', 'trialing', 'past_due', 'canceled'])[((n - 1) % 6) + 1] AS status,
    5 + (n * 3) % 120 AS seats,
    ((n % 4) * 0.03)::numeric AS discount_pct
  FROM generate_series(1, 40) AS n
)
INSERT INTO subscriptions (subscription_id, customer_id, plan_code, status, seats, mrr, currency, current_period, trial_ends_at, canceled_at, discount, created_at)
SELECT
  demo_uuid('subscription-' || n),
  demo_uuid('customer-' || n),
  b.plan_code,
  b.status::subscription_status,
  b.seats,
  round(p.monthly_price * b.seats * (1 - b.discount_pct), 2),
  'USD',
  tstzrange(date_trunc('month', now()) - interval '1 month', date_trunc('month', now()) + interval '1 month', '[)'),
  CASE WHEN b.status = 'trialing' THEN now() + interval '10 days' END,
  CASE WHEN b.status = 'canceled' THEN now() - interval '5 days' END,
  CASE WHEN b.discount_pct > 0 THEN jsonb_build_object('code', 'LOYAL10', 'percent', round(b.discount_pct * 100, 0)) ELSE '{}'::jsonb END,
  now() - ((n * 9) || ' days')::interval
FROM base b
JOIN plans p ON p.plan_code = b.plan_code;

CREATE TABLE invoices (
  invoice_id uuid PRIMARY KEY,
  subscription_id uuid NOT NULL REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,
  invoice_number text NOT NULL UNIQUE,
  issued_on date NOT NULL,
  due_on date NOT NULL,
  currency char(3) NOT NULL,
  subtotal numeric(12, 2) NOT NULL,
  tax numeric(12, 2) NOT NULL,
  total numeric(12, 2) NOT NULL,
  status invoice_status NOT NULL,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  paid_at timestamptz,
  pdf_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

WITH subs AS (
  SELECT row_number() OVER (ORDER BY c.external_id) AS rn, s.subscription_id, s.mrr
  FROM subscriptions s
  JOIN customers c USING (customer_id)
),
base AS (
  SELECT
    n,
    s.subscription_id,
    s.mrr,
    (ARRAY['paid', 'paid', 'paid', 'open', 'void', 'uncollectible'])[((n - 1) % 6) + 1]::invoice_status AS status,
    (date_trunc('month', now()) - (((n - 1) % 3) || ' months')::interval)::date AS issued_on
  FROM generate_series(1, 120) AS n
  JOIN subs s ON s.rn = (((n - 1) % 40) + 1)
)
INSERT INTO invoices (invoice_id, subscription_id, invoice_number, issued_on, due_on, currency, subtotal, tax, total, status, line_items, paid_at, pdf_url, created_at)
SELECT
  demo_uuid('invoice-' || n),
  subscription_id,
  'INV-2026-' || lpad(n::text, 4, '0'),
  issued_on,
  issued_on + 14,
  'USD',
  mrr,
  round(mrr * 0.08, 2),
  round(mrr * 1.08, 2),
  status,
  jsonb_build_array(jsonb_build_object(
    'description', 'Northstar subscription',
    'quantity', 1,
    'unit_amount', mrr
  )),
  CASE WHEN status = 'paid' THEN (issued_on + 2)::timestamptz END,
  'https://billing.northstar.example/invoices/INV-2026-' || lpad(n::text, 4, '0') || '.pdf',
  now() - ((n * 2) || ' days')::interval
FROM base;

CREATE TABLE payments (
  payment_id uuid PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_reference text NOT NULL UNIQUE,
  amount numeric(12, 2) NOT NULL,
  fee numeric(12, 2) NOT NULL,
  net numeric(12, 2) NOT NULL,
  currency char(3) NOT NULL,
  status payment_status NOT NULL,
  risk_score numeric(5, 2) NOT NULL,
  captured_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

WITH paid AS (
  SELECT row_number() OVER (ORDER BY invoice_number) AS rn, invoice_id, total
  FROM invoices
  WHERE status = 'paid'
),
fees AS (
  SELECT *, round(total * 0.029 + 0.30, 2) AS fee FROM paid
)
INSERT INTO payments (payment_id, invoice_id, provider, provider_reference, amount, fee, net, currency, status, risk_score, captured_at, metadata)
SELECT
  demo_uuid('payment-' || rn),
  invoice_id,
  (ARRAY['stripe', 'adyen', 'wire'])[((rn - 1) % 3) + 1],
  'pi_' || substr(md5('payment-' || rn), 1, 20),
  total,
  fee,
  round(total - fee, 2),
  'USD',
  'succeeded',
  round((1.2 + (rn % 20) * 0.3)::numeric, 2),
  now() - ((rn * 3) || ' hours')::interval,
  jsonb_build_object(
    'card_brand', (ARRAY['visa', 'mastercard', 'amex'])[((rn - 1) % 3) + 1],
    'card_last4', lpad(((rn * 37) % 10000)::text, 4, '0'),
    'statement_descriptor', 'NORTHSTAR'
  )
FROM fees;

CREATE TABLE tickets (
  ticket_id uuid PRIMARY KEY,
  ticket_key text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(contact_id),
  assignee_id uuid REFERENCES staff(staff_id),
  subject text NOT NULL,
  description text NOT NULL,
  priority ticket_priority NOT NULL,
  status ticket_status NOT NULL,
  channel ticket_channel NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  sla interval NOT NULL,
  opened_at timestamptz NOT NULL,
  first_response_at timestamptz,
  resolved_at timestamptz,
  satisfaction smallint CHECK (satisfaction BETWEEN 1 AND 5),
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb
);

WITH customer_rows AS (
  SELECT row_number() OVER (ORDER BY external_id) AS rn, customer_id
  FROM customers
),
base AS (
  SELECT
    n,
    ((n - 1) % 40) + 1 AS customer_rn,
    (ARRAY[
      'Cannot access SSO after domain change',
      'Invoice shows the wrong billing contact',
      'API requests are timing out for large exports',
      'Mobile app crashes when opening attachments',
      'Need help importing historical ticket data',
      'Webhook retries are creating duplicate events',
      'User provisioning is stuck in pending state',
      'Requesting a copy of our audit log',
      'Dashboard charts are missing weekend data',
      'Unexpected seat count after team restructure',
      'SAML certificate is expiring next week',
      'Bulk update changed the wrong ticket status',
      'Attachment upload fails for files over 50 MB',
      'Need to change our primary support email',
      'Usage report does not match the invoice',
      'Search is not returning recently closed tickets',
      'Two contacts are receiving duplicate notifications',
      'Custom field values disappeared after import',
      'Cannot remove a deactivated team member',
      'Question about data retention and deletion'
    ])[((n - 1) % 20) + 1] AS subject,
    (ARRAY[
      'Since we updated our identity provider metadata, users are redirected to an error page. We verified the entity ID and certificate but the loop continues.',
      'The invoice was sent to our former finance lead. Please update the billing contact and resend the current invoice.',
      'Exports larger than 100k rows usually finish in a few minutes. Today they time out after 30 seconds with a gateway error.',
      'The iOS app closes immediately when a ticket contains a PDF attachment. Android works normally and the web app is unaffected.',
      'We are migrating from another help desk and need to preserve ticket timestamps, requester emails, and internal notes.',
      'Our endpoint returns 500 for some deliveries. Northstar retries them, but the retry creates a second event with the same logical ID.',
      'New hires created through SCIM remain pending and never receive the welcome email. Manual invites work as expected.',
      'Our security team needs audit events for the last 12 months in CSV or JSON, including actor, action, and source IP.',
      'The weekly trend chart skips Saturday and Sunday for our timezone. The underlying export includes those rows.',
      'We removed 18 seats last month but the renewal quote still shows the old count. We need the contract corrected before approval.',
      'Our SAML signing certificate expires next Friday. Please confirm the rotation steps and whether metadata can be uploaded in advance.',
      'A bulk status change was applied to 42 tickets instead of the 4 selected. We need help identifying and reverting the affected records.',
      'Uploads over 50 MB fail with a generic network error. Smaller files work and direct uploads to storage succeed.',
      'We are changing our support address from it@ to help@. Please update the inbound address and notification templates.',
      'The usage page shows 1.8 million API calls while the invoice counts 2.4 million. We need the calculation explained.',
      'Search returns older tickets but not the ones closed this week. Reindexing from the admin panel did not change the result.',
      'Both our primary and secondary contacts receive every update. The secondary contact should only receive escalations.',
      'After importing 6,000 records, the renewal risk custom field is empty for most tickets. The CSV column was populated.',
      'A former employee still appears in the assignment list even though their account is deactivated. We cannot remove them.',
      'Please clarify how long resolved tickets and attachments are retained, and whether we can request early deletion.'
    ])[((n - 1) % 20) + 1] AS description,
    (ARRAY['low', 'normal', 'high', 'urgent'])[((n - 1) % 4) + 1]::ticket_priority AS priority,
    (ARRAY['new', 'open', 'pending', 'resolved', 'closed'])[((n - 1) % 5) + 1]::ticket_status AS status,
    (ARRAY['email', 'chat', 'phone', 'web', 'api'])[((n - 1) % 5) + 1]::ticket_channel AS channel,
    now() - ((n * 9) || ' hours')::interval AS opened_at
  FROM generate_series(1, 80) AS n
)
INSERT INTO tickets (ticket_id, ticket_key, customer_id, contact_id, assignee_id, subject, description, priority, status, channel, tags, sla, opened_at, first_response_at, resolved_at, satisfaction, custom_fields)
SELECT
  demo_uuid('ticket-' || n),
  'SUP-' || (1000 + n),
  c.customer_id,
  demo_uuid('contact-' || (((customer_rn - 1) * 3) + ((n - 1) % 3) + 1)),
  demo_uuid('staff-' || ((n % 12) + 1)),
  subject,
  description,
  priority,
  status,
  channel,
  ARRAY[
    (ARRAY['sso', 'billing', 'api', 'mobile', 'reporting'])[((n - 1) % 5) + 1],
    (ARRAY['customer-report', 'escalated'])[((n - 1) % 2) + 1]
  ],
  make_interval(hours => ((n % 3) + 1) * 4),
  opened_at,
  opened_at + make_interval(mins => 18 + (n % 40)),
  CASE WHEN status IN ('resolved', 'closed') THEN opened_at + make_interval(hours => 6 + (n % 30)) END,
  CASE WHEN status IN ('resolved', 'closed') THEN 3 + (n % 3) END,
  jsonb_build_object(
    'product_area', (ARRAY['authentication', 'billing', 'api', 'mobile', 'reporting'])[((n - 1) % 5) + 1],
    'environment', (ARRAY['production', 'staging'])[((n - 1) % 2) + 1],
    'browser', (ARRAY['Chrome 131', 'Safari 18', 'Firefox 133', 'Edge 131'])[((n - 1) % 4) + 1]
  )
FROM base
JOIN customer_rows c ON c.rn = base.customer_rn;

CREATE TABLE ticket_messages (
  message_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  ticket_id uuid NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
  author_type author_type NOT NULL,
  author_id uuid,
  body text NOT NULL,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  internal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

WITH ticket_rows AS (
  SELECT row_number() OVER (ORDER BY ticket_key) AS rn, ticket_id, contact_id, assignee_id
  FROM tickets
),
base AS (
  SELECT
    n,
    ((n - 1) / 3) + 1 AS ticket_rn,
    (ARRAY[
      'Thanks for the quick response. I confirmed the issue happens in both Chrome and Safari.',
      'I reproduced this on our side. The timeout starts when the export crosses roughly 100k rows.',
      'We updated the billing contact and resent the invoice. Please confirm it arrived.',
      'I can see the duplicate deliveries in our logs. They share the same event ID but have different delivery IDs.',
      'Our identity provider team is reviewing the metadata now. I will send the updated XML shortly.',
      'The seat count has been corrected on the renewal quote. The new PDF is attached to the billing record.',
      'We rotated the SAML certificate and uploaded the new metadata. SSO is working again for all users.',
      'I found the 42 tickets affected by the bulk update and restored their previous status values.',
      'The retention policy is 24 months for resolved tickets and 12 months for attachments. Deletion requests are handled within 30 days.',
      'The search index has been rebuilt. Recently closed tickets are now appearing in results.',
      'I removed the former employee from the assignment list and transferred their open tickets to the support lead.',
      'The usage difference came from retries that were counted twice. We issued a credit for the overage.'
    ])[((n - 1) % 12) + 1] AS body
  FROM generate_series(1, 240) AS n
)
INSERT INTO ticket_messages (ticket_id, author_type, author_id, body, attachments, internal, created_at)
SELECT
  t.ticket_id,
  (CASE WHEN n % 3 = 1 THEN 'customer' ELSE 'agent' END)::author_type,
  CASE WHEN n % 3 = 1 THEN t.contact_id ELSE t.assignee_id END,
  body,
  CASE WHEN n % 5 = 0 THEN jsonb_build_array(jsonb_build_object('name', 'screen-capture.png', 'size_bytes', 184320)) ELSE '[]'::jsonb END,
  n % 4 = 0,
  now() - ((n * 2) || ' hours')::interval
FROM base
JOIN ticket_rows t ON t.rn = base.ticket_rn;

CREATE TABLE projects (
  project_id uuid PRIMARY KEY,
  project_code text NOT NULL UNIQUE,
  customer_id uuid NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  name text NOT NULL,
  status project_status NOT NULL,
  starts_on date NOT NULL,
  due_on date NOT NULL,
  budget numeric(12, 2) NOT NULL,
  lead_id uuid NOT NULL REFERENCES staff(staff_id),
  labels text[] NOT NULL DEFAULT '{}',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO projects (project_id, project_code, customer_id, name, status, starts_on, due_on, budget, lead_id, labels, settings)
SELECT
  demo_uuid('project-' || n),
  'PRJ-' || lpad(n::text, 3, '0'),
  demo_uuid('customer-' || (((n - 1) % 40) + 1)),
  (ARRAY[
    'Customer portal refresh', 'Data warehouse migration', 'SSO rollout',
    'Mobile app launch', 'Billing automation', 'API v2 migration',
    'SOC 2 readiness', 'Onboarding redesign', 'Usage analytics',
    'Partner integration', 'Custom report builder', 'Email deliverability',
    'Contact import cleanup', 'Ticket routing overhaul', 'Knowledge base launch',
    'Multi-region rollout', 'Audit log export', 'Webhook reliability',
    'Seat management redesign', 'Support SLA reporting', 'Identity provider cutover',
    'Historical data archive', 'Sandbox environment setup', 'Notification preferences',
    'Quarterly business review'
  ])[n],
  (ARRAY['planned', 'active', 'active', 'paused', 'completed'])[((n - 1) % 5) + 1]::project_status,
  current_date - (n * 9),
  current_date + (n * 14),
  round((12000 + (n * 3700) % 90000)::numeric, 2),
  demo_uuid('staff-' || ((n % 12) + 1)),
  ARRAY[
    (ARRAY['implementation', 'migration', 'security', 'analytics', 'enablement'])[((n - 1) % 5) + 1],
    (ARRAY['fixed-fee', 'time-and-materials'])[((n - 1) % 2) + 1]
  ],
  jsonb_build_object(
    'billing', (ARRAY['fixed-fee', 'time-and-materials'])[((n - 1) % 2) + 1],
    'region', (ARRAY['us-east', 'us-west', 'eu-central'])[((n - 1) % 3) + 1],
    'kickoff_complete', n % 3 <> 0
  )
FROM generate_series(1, 25) AS n;

CREATE TABLE tasks (
  task_id uuid PRIMARY KEY,
  task_key text NOT NULL UNIQUE,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  parent_task_id uuid REFERENCES tasks(task_id),
  title text NOT NULL,
  description text NOT NULL,
  status task_status NOT NULL,
  priority ticket_priority NOT NULL,
  estimate interval NOT NULL,
  spent interval NOT NULL,
  assignee_id uuid REFERENCES staff(staff_id),
  due_at timestamptz,
  completed_at timestamptz,
  position numeric(8, 2) NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb
);

WITH project_rows AS (
  SELECT row_number() OVER (ORDER BY project_code) AS rn, project_id
  FROM projects
),
base AS (
  SELECT
    n,
    ((n - 1) % 25) + 1 AS project_rn,
    (ARRAY[
      'Map current authentication flow', 'Draft migration runbook',
      'Export legacy ticket metadata', 'Validate SSO test users',
      'Build billing reconciliation report', 'Review API rate limits',
      'Document webhook retry behavior', 'Create rollback checklist',
      'Configure staging environment', 'Import customer contact list',
      'Design usage dashboard', 'Add audit log filters',
      'Update onboarding email sequence', 'Test seat downgrade path',
      'Prepare security questionnaire', 'Migrate saved reports',
      'Tune search index settings', 'Add custom field validation',
      'Set up alert routing', 'Review data retention rules',
      'Write acceptance criteria', 'Schedule customer walkthrough',
      'Fix duplicate notification bug', 'Create support macros',
      'Update knowledge base screenshots', 'Verify mobile attachment upload',
      'Load test the export endpoint', 'Add region failover test',
      'Review SAML certificate rotation', 'Publish launch announcement'
    ])[((n - 1) % 30) + 1] AS title,
    (ARRAY[
      'Capture the current behavior, owners, and known edge cases before changing anything.',
      'Document the sequence of steps, validation checks, and rollback criteria.',
      'Include ticket IDs, requester emails, timestamps, and internal notes.',
      'Use the customer test tenant and confirm both admin and standard user flows.',
      'Compare invoice line items with usage records for the last three billing periods.',
      'Confirm limits for bulk endpoints and document the expected 429 response.',
      'Verify idempotency keys and the retry schedule during a simulated outage.',
      'List every dependency and the exact command needed to restore service.',
      'Provision the environment with production-like data and access controls.',
      'Deduplicate by email and preserve the original owner and lifecycle stage.',
      'Show API calls, storage, seats, and overage with a consistent time range.',
      'Allow filtering by actor, action, resource, and source IP address.',
      'Review copy with support and customer success before the next campaign.',
      'Confirm proration, renewal date, and invoice impact with finance.',
      'Answer the security questions using the current SOC 2 evidence.',
      'Recreate the five most-used reports and compare row counts.',
      'Measure query latency before and after the analyzer update.',
      'Reject invalid values at the API boundary and show a useful error.',
      'Route critical alerts to the on-call channel and test the escalation path.',
      'Align the policy with the latest legal and customer commitments.',
      'Write testable criteria with the customer and implementation lead.',
      'Record the session and share the notes with the project channel.',
      'Reproduce with two contacts and confirm only one notification is sent.',
      'Draft macros for the top ten ticket intents and review with the team.',
      'Refresh screenshots for SSO, billing, and ticket routing articles.',
      'Test files from 10 MB to 100 MB on iOS and Android.',
      'Run the load test with 250 concurrent export requests.',
      'Simulate a regional outage and verify traffic moves to the standby.',
      'Confirm the new certificate is active before the old one expires.',
      'Prepare the customer-facing summary, timeline, and support contacts.'
    ])[((n - 1) % 30) + 1] AS description,
    (ARRAY['backlog', 'todo', 'in_progress', 'blocked', 'review', 'done'])[((n - 1) % 6) + 1]::task_status AS status,
    (ARRAY['low', 'normal', 'high', 'urgent'])[((n - 1) % 4) + 1]::ticket_priority AS priority,
    make_interval(hours => (n % 16) + 2) AS estimate,
    make_interval(hours => (n % 20) + 1) AS spent,
    now() + ((n % 45) || ' days')::interval AS due_at
  FROM generate_series(1, 200) AS n
)
INSERT INTO tasks (task_id, task_key, project_id, parent_task_id, title, description, status, priority, estimate, spent, assignee_id, due_at, completed_at, position, tags, checklist)
SELECT
  demo_uuid('task-' || n),
  'TASK-' || (1000 + n),
  p.project_id,
  NULL,
  title,
  description,
  status,
  priority,
  estimate,
  spent,
  demo_uuid('staff-' || ((n % 12) + 1)),
  due_at,
  CASE WHEN status = 'done' THEN due_at - interval '2 days' END,
  round((n % 100)::numeric / 10, 1),
  ARRAY[
    (ARRAY['backend', 'frontend', 'data', 'security', 'docs'])[((n - 1) % 5) + 1],
    (ARRAY['customer-visible', 'internal'])[((n - 1) % 2) + 1]
  ],
  jsonb_build_array(
    jsonb_build_object('label', 'Implementation complete', 'done', status = 'done'),
    jsonb_build_object('label', 'Reviewed by project lead', 'done', n % 4 = 0),
    jsonb_build_object('label', 'Customer sign-off', 'done', n % 7 = 0)
  )
FROM base
JOIN project_rows p ON p.rn = base.project_rn;

UPDATE tasks
SET parent_task_id = demo_uuid('task-' || (split_part(task_key, '-', 2)::int - 1001))
WHERE (split_part(task_key, '-', 2)::int - 1000) % 7 = 0;

CREATE TABLE task_comments (
  comment_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES staff(staff_id),
  body text NOT NULL,
  mentions uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

WITH task_rows AS (
  SELECT row_number() OVER (ORDER BY task_key) AS rn, task_id
  FROM tasks
)
INSERT INTO task_comments (task_id, author_id, body, mentions, created_at)
SELECT
  t.task_id,
  demo_uuid('staff-' || ((n % 12) + 1)),
  (ARRAY[
    'I picked this up and added the first pass to the project branch.',
    'The customer confirmed the test users are ready for validation.',
    'Found an edge case with expired sessions. Added it to the acceptance criteria.',
    'Finance reviewed the numbers and flagged one invoice that needs a credit.',
    'The staging environment is provisioned. I will post access details in the channel.',
    'Load test results look healthy at 200 concurrent requests. Retesting at 250.',
    'Blocked on the identity provider metadata. Following up with the customer today.',
    'Updated the runbook with the rollback commands and validation queries.',
    'Customer asked to move the walkthrough to Thursday afternoon.',
    'The search reindex finished and recent tickets are now visible.',
    'I added the new screenshots to the knowledge base draft.',
    'This is ready for review. The checklist and test notes are in the task description.'
  ])[((n - 1) % 12) + 1],
  ARRAY[demo_uuid('staff-' || (((n + 3) % 12) + 1))],
  now() - ((n * 4) || ' hours')::interval
FROM generate_series(1, 300) AS n
JOIN task_rows t ON t.rn = n;

CREATE TABLE sprints (
  sprint_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  name text NOT NULL,
  period tstzrange NOT NULL,
  capacity numeric(6, 1) NOT NULL,
  velocity numeric(6, 1) NOT NULL
);

WITH project_rows AS (
  SELECT row_number() OVER (ORDER BY project_code) AS rn, project_id
  FROM projects
)
INSERT INTO sprints (sprint_id, project_id, name, period, capacity, velocity)
SELECT
  demo_uuid('sprint-' || n),
  p.project_id,
  'Sprint ' || ((n + 1) / 2),
  tstzrange(
    date_trunc('week', now()) - ((n % 8) || ' weeks')::interval,
    date_trunc('week', now()) - ((n % 8) || ' weeks')::interval + interval '2 weeks',
    '[)'
  ),
  40 + (n % 10) * 5,
  32 + (n % 8) * 4
FROM generate_series(1, 50) AS n
JOIN project_rows p ON p.rn = (((n - 1) / 2) + 1);

CREATE TABLE task_sprints (
  task_id uuid NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
  sprint_id uuid NOT NULL REFERENCES sprints(sprint_id) ON DELETE CASCADE,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, sprint_id)
);

WITH task_rows AS (
  SELECT row_number() OVER (ORDER BY task_key) AS rn, task_id
  FROM tasks
),
sprint_rows AS (
  SELECT row_number() OVER (ORDER BY sprint_id) AS rn, sprint_id
  FROM sprints
)
INSERT INTO task_sprints (task_id, sprint_id, added_at)
SELECT
  t.task_id,
  s.sprint_id,
  now() - ((n * 3) || ' days')::interval
FROM generate_series(1, 150) AS n
JOIN task_rows t ON t.rn = n
JOIN sprint_rows s ON s.rn = (((n - 1) % 50) + 1);

CREATE TABLE usage_daily (
  customer_id uuid NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  api_calls bigint NOT NULL,
  storage_bytes bigint NOT NULL,
  active_seats integer NOT NULL,
  overage_amount numeric(10, 2) NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (customer_id, usage_date)
);

INSERT INTO usage_daily (customer_id, usage_date, api_calls, storage_bytes, active_seats, overage_amount, metrics)
SELECT
  demo_uuid('customer-' || c),
  current_date - d,
  ((c * 137 + d * 53) % 50000 + 1200)::bigint,
  (c * 1048576 * 3 + d * 2097152)::bigint,
  5 + ((c + d) % 40),
  round((((c * 137 + d * 53) % 50000)::numeric * 0.0004), 2),
  jsonb_build_object(
    'api_calls_p95', 800 + ((c * 29 + d * 17) % 4200),
    'error_rate', round((((c + d) % 40)::numeric / 1000), 4),
    'regions', jsonb_build_array('us-east-1', 'eu-west-1')
  )
FROM generate_series(1, 40) AS c
CROSS JOIN generate_series(0, 44) AS d;

CREATE TABLE feature_flags (
  flag_key text PRIMARY KEY,
  description text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  rollout_percent smallint NOT NULL CHECK (rollout_percent BETWEEN 0 AND 100),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO feature_flags (flag_key, description, enabled, rollout_percent, rules, updated_at) VALUES
  ('ai_ticket_summary', 'Show an AI-generated summary above the ticket conversation.', true, 35,
   '{"plans": ["scale", "enterprise"], "exclude_regions": []}'::jsonb, now() - interval '3 days'),
  ('bulk_ticket_edit', 'Allow support agents to update up to 100 tickets at once.', true, 100,
   '{"roles": ["admin", "agent"]}'::jsonb, now() - interval '18 days'),
  ('custom_report_builder', 'Enable the drag-and-drop report builder in analytics.', true, 60,
   '{"plans": ["growth", "scale", "enterprise"]}'::jsonb, now() - interval '9 days'),
  ('webhook_replay', 'Allow customers to replay failed webhook deliveries.', false, 0,
   '{"plans": ["scale", "enterprise"]}'::jsonb, now() - interval '1 day'),
  ('seat_downgrade_proration', 'Apply prorated credits when seats are removed mid-cycle.', true, 80,
   '{"billing_provider": "stripe"}'::jsonb, now() - interval '27 days'),
  ('saml_certificate_rotation', 'Self-service SAML certificate rotation flow.', true, 45,
   '{"plans": ["growth", "scale", "enterprise"]}'::jsonb, now() - interval '5 days'),
  ('search_v2', 'New ranking model for ticket and article search.', true, 25,
   '{"workspace_bucket": [0, 24]}'::jsonb, now() - interval '2 days'),
  ('audit_log_export', 'Export audit events as CSV or NDJSON.', true, 100,
   '{"plans": ["growth", "scale", "enterprise"]}'::jsonb, now() - interval '40 days'),
  ('mobile_attachment_preview', 'Preview PDF and image attachments inside the mobile app.', false, 0,
   '{"platforms": ["ios", "android"]}'::jsonb, now() - interval '12 hours'),
  ('usage_alerts', 'Send proactive alerts when usage approaches the plan limit.', true, 70,
   '{"plans": ["growth", "scale", "enterprise"]}'::jsonb, now() - interval '7 days'),
  ('sso_enforcement', 'Require SSO for all members of a workspace.', true, 100,
   '{"plans": ["scale", "enterprise"]}'::jsonb, now() - interval '60 days'),
  ('dark_mode', 'Dark appearance for the agent workspace.', true, 100,
   '{"roles": ["admin", "agent", "viewer"]}'::jsonb, now() - interval '90 days');

CREATE TABLE experiments (
  experiment_id uuid PRIMARY KEY,
  flag_key text NOT NULL REFERENCES feature_flags(flag_key),
  name text NOT NULL,
  status experiment_status NOT NULL,
  variants jsonb NOT NULL,
  started_at timestamptz,
  ended_at timestamptz
);

INSERT INTO experiments (experiment_id, flag_key, name, status, variants, started_at, ended_at) VALUES
  (demo_uuid('experiment-1'), 'ai_ticket_summary', 'AI summary placement', 'running',
   '{"control": 50, "treatment": 50}'::jsonb, now() - interval '21 days', NULL),
  (demo_uuid('experiment-2'), 'custom_report_builder', 'Report builder onboarding', 'running',
   '{"control": 34, "guided": 33, "template_first": 33}'::jsonb, now() - interval '14 days', NULL),
  (demo_uuid('experiment-3'), 'search_v2', 'Search ranking v2', 'running',
   '{"control": 50, "treatment": 50}'::jsonb, now() - interval '9 days', NULL),
  (demo_uuid('experiment-4'), 'seat_downgrade_proration', 'Downgrade messaging', 'completed',
   '{"control": 50, "treatment": 50}'::jsonb, now() - interval '70 days', now() - interval '35 days'),
  (demo_uuid('experiment-5'), 'saml_certificate_rotation', 'Certificate rotation checklist', 'paused',
   '{"control": 50, "treatment": 50}'::jsonb, now() - interval '18 days', NULL),
  (demo_uuid('experiment-6'), 'usage_alerts', 'Usage alert threshold', 'running',
   '{"control": 50, "at_80_percent": 25, "at_70_percent": 25}'::jsonb, now() - interval '11 days', NULL),
  (demo_uuid('experiment-7'), 'bulk_ticket_edit', 'Bulk edit confirmation', 'completed',
   '{"control": 50, "treatment": 50}'::jsonb, now() - interval '120 days', now() - interval '80 days'),
  (demo_uuid('experiment-8'), 'webhook_replay', 'Replay button label', 'draft',
   '{"control": 50, "treatment": 50}'::jsonb, NULL, NULL);

CREATE TABLE experiment_assignments (
  experiment_id uuid NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
  subject_id uuid NOT NULL,
  variant text NOT NULL,
  assigned_at timestamptz NOT NULL,
  converted boolean NOT NULL DEFAULT false,
  revenue numeric(12, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (experiment_id, subject_id)
);

WITH experiment_rows AS (
  SELECT row_number() OVER (ORDER BY experiment_id) AS rn, experiment_id
  FROM experiments
)
INSERT INTO experiment_assignments (experiment_id, subject_id, variant, assigned_at, converted, revenue)
SELECT
  e.experiment_id,
  demo_uuid('subject-' || n),
  (ARRAY['control', 'treatment'])[((n - 1) % 2) + 1],
  now() - ((n * 7) || ' hours')::interval,
  n % 7 = 0,
  round(((n % 13) * 17.5)::numeric, 2)
FROM generate_series(1, 400) AS n
JOIN experiment_rows e ON e.rn = (((n - 1) % 8) + 1);

CREATE TABLE events (
  event_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  event_name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL
);

INSERT INTO events (customer_id, session_id, event_name, properties, context, ip, occurred_at, received_at)
SELECT
  demo_uuid('customer-' || (((n - 1) % 40) + 1)),
  demo_uuid('session-' || n),
  (ARRAY[
    'ticket.created', 'ticket.updated', 'ticket.resolved', 'invoice.paid',
    'subscription.updated', 'task.completed', 'file.uploaded', 'api.request',
    'user.login', 'user.invited', 'webhook.delivered', 'report.exported',
    'search.performed', 'usage.threshold_reached', 'sso.login'
  ])[((n - 1) % 15) + 1],
  jsonb_build_object(
    'plan', (ARRAY['starter', 'growth', 'scale', 'enterprise'])[((n - 1) % 4) + 1],
    'value', round(((n % 50) * 2.5)::numeric, 2),
    'source', (ARRAY['web', 'api', 'mobile'])[((n - 1) % 3) + 1]
  ),
  jsonb_build_object(
    'request_id', 'req_' || substr(md5('request-' || n), 1, 16),
    'version', '2026.10.' || (n % 20),
    'region', (ARRAY['us-east-1', 'us-west-2', 'eu-west-1'])[((n - 1) % 3) + 1]
  ),
  ('10.0.' || (n % 255) || '.' || ((n * 7) % 255))::inet,
  now() - (n || ' minutes')::interval,
  now() - (n || ' minutes')::interval + interval '2 seconds'
FROM generate_series(1, 600) AS n;

CREATE TABLE audit_log (
  audit_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES staff(staff_id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  before_state jsonb,
  after_state jsonb,
  ip inet NOT NULL,
  occurred_at timestamptz NOT NULL
);

INSERT INTO audit_log (actor_id, action, resource_type, resource_id, before_state, after_state, ip, occurred_at)
SELECT
  demo_uuid('staff-' || ((n % 12) + 1)),
  (ARRAY[
    'invoice.sent', 'invoice.voided', 'subscription.cancelled',
    'subscription.plan_changed', 'ticket.reassigned', 'ticket.status_changed',
    'task.completed', 'api_key.created', 'api_key.revoked', 'member.deactivated'
  ])[((n - 1) % 10) + 1],
  (ARRAY['invoice', 'subscription', 'ticket', 'task', 'api_key', 'member'])[((n - 1) % 6) + 1],
  demo_uuid((ARRAY['invoice-', 'subscription-', 'ticket-', 'task-', 'api-key-', 'staff-'])[((n - 1) % 6) + 1] || ((n % 40) + 1)),
  jsonb_build_object('status', (ARRAY['open', 'active', 'pending'])[((n - 1) % 3) + 1]),
  jsonb_build_object('status', (ARRAY['paid', 'canceled', 'resolved', 'done'])[((n - 1) % 4) + 1]),
  ('10.1.' || (n % 255) || '.' || ((n * 11) % 255))::inet,
  now() - ((n * 13) || ' minutes')::interval
FROM generate_series(1, 400) AS n;

CREATE TABLE api_keys (
  api_key_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL UNIQUE,
  hashed_secret text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO api_keys (api_key_id, customer_id, name, prefix, hashed_secret, scopes, last_used_at, expires_at, revoked_at, created_at)
SELECT
  demo_uuid('api-key-' || n),
  demo_uuid('customer-' || (((n - 1) / 2) + 1)),
  (ARRAY['Production', 'Staging'])[((n - 1) % 2) + 1],
  'nsk_live_' || substr(md5('key-' || n), 1, 12),
  md5('secret-' || n),
  CASE ((n - 1) % 3)
    WHEN 0 THEN ARRAY['tickets:read', 'tickets:write']
    WHEN 1 THEN ARRAY['usage:read', 'reports:read']
    ELSE ARRAY['webhooks:manage', 'files:write']
  END,
  now() - ((n * 5) || ' hours')::interval,
  now() + (((n % 12) + 1) * 30 || ' days')::interval,
  CASE WHEN n % 11 = 0 THEN now() - interval '2 days' END,
  now() - ((n * 17) || ' days')::interval
FROM generate_series(1, 80) AS n;

CREATE TABLE files (
  file_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  uploaded_by uuid NOT NULL REFERENCES staff(staff_id),
  bucket text NOT NULL,
  object_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  checksum text NOT NULL,
  virus_scanned boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO files (file_id, customer_id, uploaded_by, bucket, object_key, content_type, size_bytes, checksum, virus_scanned, metadata, created_at)
SELECT
  demo_uuid('file-' || n),
  demo_uuid('customer-' || (((n - 1) % 40) + 1)),
  demo_uuid('staff-' || ((n % 12) + 1)),
  'northstar-attachments',
  'uploads/2026/' || lpad(n::text, 4, '0') || '-' ||
    (ARRAY['screenshot', 'contract', 'invoice', 'export'])[((n - 1) % 4) + 1] || '.' ||
    (ARRAY['png', 'pdf', 'csv', 'json'])[((n - 1) % 4) + 1],
  (ARRAY['image/png', 'application/pdf', 'text/csv', 'application/json'])[((n - 1) % 4) + 1],
  (25000 + (n * 7919) % 8000000)::bigint,
  md5('file-' || n),
  n % 13 <> 0,
  jsonb_build_object(
    'uploaded_from', (ARRAY['web', 'api', 'mobile'])[((n - 1) % 3) + 1],
    'retention_days', 365,
    'owner_team', (ARRAY['support', 'finance', 'security'])[((n - 1) % 3) + 1]
  ),
  now() - ((n * 7) || ' hours')::interval
FROM generate_series(1, 100) AS n;

CREATE TABLE webhooks (
  webhook_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES customers(customer_id) ON DELETE CASCADE,
  url text NOT NULL,
  events text[] NOT NULL,
  secret_prefix text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

WITH customer_rows AS (
  SELECT row_number() OVER (ORDER BY external_id) AS rn, customer_id, domain
  FROM customers
)
INSERT INTO webhooks (webhook_id, customer_id, url, events, secret_prefix, active, created_at)
SELECT
  demo_uuid('webhook-' || n),
  c.customer_id,
  'https://api.' || c.domain || '/hooks/northstar',
  CASE ((n - 1) % 3)
    WHEN 0 THEN ARRAY['ticket.created', 'ticket.updated', 'ticket.resolved']
    WHEN 1 THEN ARRAY['invoice.paid', 'subscription.updated']
    ELSE ARRAY['ticket.created', 'webhook.test']
  END,
  'whsec_' || substr(md5('webhook-' || n), 1, 10),
  n % 7 <> 0,
  now() - ((n * 23) || ' days')::interval
FROM generate_series(1, 20) AS n
JOIN customer_rows c ON c.rn = n;

CREATE TABLE webhook_deliveries (
  delivery_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  webhook_id uuid NOT NULL REFERENCES webhooks(webhook_id) ON DELETE CASCADE,
  event_name text NOT NULL,
  payload jsonb NOT NULL,
  status_code integer NOT NULL,
  attempt smallint NOT NULL,
  delivered_at timestamptz,
  error text
);

WITH webhook_rows AS (
  SELECT row_number() OVER (ORDER BY webhook_id) AS rn, webhook_id
  FROM webhooks
)
INSERT INTO webhook_deliveries (webhook_id, event_name, payload, status_code, attempt, delivered_at, error)
SELECT
  w.webhook_id,
  (ARRAY['ticket.created', 'ticket.updated', 'invoice.paid', 'subscription.updated', 'webhook.test'])[((n - 1) % 5) + 1],
  jsonb_build_object(
    'id', 'evt_' || substr(md5('delivery-' || n), 1, 20),
    'type', (ARRAY['ticket.created', 'ticket.updated', 'invoice.paid', 'subscription.updated', 'webhook.test'])[((n - 1) % 5) + 1],
    'created', now() - ((n * 4) || ' minutes')::interval,
    'data', jsonb_build_object('customer_id', 'cus_' || lpad((((n - 1) % 40) + 1)::text, 5, '0'))
  ),
  CASE
    WHEN n % 9 = 0 THEN 500
    WHEN n % 7 = 0 THEN 400
    WHEN n % 5 = 0 THEN 202
    ELSE 200
  END,
  1 + (n % 3),
  now() - ((n * 4) || ' minutes')::interval,
  CASE
    WHEN n % 9 = 0 THEN 'connection reset by peer'
    WHEN n % 7 = 0 THEN 'response validation failed'
  END
FROM generate_series(1, 300) AS n
JOIN webhook_rows w ON w.rn = (((n - 1) % 20) + 1);

CREATE TABLE notifications (
  notification_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES staff(staff_id) ON DELETE CASCADE,
  channel notification_channel NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  read_at timestamptz,
  sent_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO notifications (staff_id, channel, subject, body, read_at, sent_at, metadata)
SELECT
  demo_uuid('staff-' || ((n % 12) + 1)),
  (ARRAY['email', 'in_app', 'slack', 'webhook'])[((n - 1) % 4) + 1]::notification_channel,
  (ARRAY[
    'New urgent ticket assigned to you',
    'Invoice payment received',
    'Subscription cancellation requested',
    'Webhook deliveries are failing',
    'Sprint review starts in 30 minutes',
    'Usage threshold reached for a customer',
    'Security review requires your input',
    'Customer replied to SUP-1042',
    'Certificate rotation completed',
    'Weekly support summary is ready'
  ])[((n - 1) % 10) + 1],
  (ARRAY[
    'A customer reported a production issue and the SLA timer has started.',
    'The latest invoice was paid successfully and the receipt is available.',
    'A customer requested cancellation at the end of the current billing period.',
    'Five deliveries failed in the last hour. Check the webhook delivery log.',
    'The project team is waiting for your update before the review.',
    'A customer is approaching the API call limit for the current billing period.',
    'The annual access review needs approval for three production systems.',
    'The customer confirmed the fix and asked for a short follow-up call.',
    'The new SAML certificate is active and the old certificate has been retired.',
    'The weekly summary includes volume, response time, and satisfaction trends.'
  ])[((n - 1) % 10) + 1],
  CASE WHEN n % 4 = 0 THEN now() - ((n * 2) || ' hours')::interval END,
  now() - ((n * 6) || ' hours')::interval,
  jsonb_build_object(
    'resource_type', (ARRAY['ticket', 'invoice', 'subscription', 'webhook', 'project'])[((n - 1) % 5) + 1],
    'resource_id', 'res_' || substr(md5('notification-' || n), 1, 12)
  )
FROM generate_series(1, 150) AS n;

CREATE TABLE exchange_rates (
  rate_date date NOT NULL,
  currency char(3) NOT NULL,
  rate_to_usd numeric(12, 6) NOT NULL CHECK (rate_to_usd > 0),
  PRIMARY KEY (rate_date, currency)
);

INSERT INTO exchange_rates (rate_date, currency, rate_to_usd)
SELECT
  (current_date - d)::date,
  (ARRAY['EUR', 'GBP', 'CAD', 'AUD', 'JPY'])[c],
  round(((ARRAY[1.08, 1.27, 0.74, 0.66, 0.0067])[c] + d * 0.0003)::numeric, 6)
FROM generate_series(1, 5) AS c
CROSS JOIN generate_series(0, 29) AS d;

CREATE TABLE maintenance_windows (
  window_id uuid PRIMARY KEY,
  service text NOT NULL,
  period tstzrange NOT NULL,
  impact impact_level NOT NULL,
  description text NOT NULL,
  created_by uuid NOT NULL REFERENCES staff(staff_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  EXCLUDE USING gist (service WITH =, period WITH &&)
);

INSERT INTO maintenance_windows (window_id, service, period, impact, description, created_by, created_at)
SELECT
  demo_uuid('maintenance-' || n),
  (ARRAY['api', 'billing', 'webhooks', 'dashboard'])[((n - 1) % 4) + 1],
  tstzrange(
    now() + ((n * 7) || ' days')::interval,
    now() + (((n * 7) + 2) || ' days')::interval,
    '[)'
  ),
  (ARRAY['none', 'minor', 'major'])[((n - 1) % 3) + 1]::impact_level,
  (ARRAY[
    'Routine database maintenance with brief read-only periods.',
    'Billing provider upgrade. Invoice generation may be delayed.',
    'Webhook delivery workers will be rolled out in stages.',
    'Dashboard cache warm-up after a storage migration.'
  ])[((n - 1) % 4) + 1],
  demo_uuid('staff-' || ((n % 12) + 1)),
  now() - ((n * 2) || ' days')::interval
FROM generate_series(1, 10) AS n;

CREATE TABLE service_incidents (
  incident_id uuid PRIMARY KEY,
  service text NOT NULL,
  severity incident_severity NOT NULL,
  status incident_status NOT NULL,
  started_at timestamptz NOT NULL,
  resolved_at timestamptz,
  summary text NOT NULL,
  timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_regions text[] NOT NULL DEFAULT '{}'
);

INSERT INTO service_incidents (incident_id, service, severity, status, started_at, resolved_at, summary, timeline, affected_regions)
SELECT
  demo_uuid('incident-' || n),
  (ARRAY['API', 'Billing', 'Webhooks', 'Dashboard', 'Ingestion'])[((n - 1) % 5) + 1],
  (ARRAY['sev1', 'sev2', 'sev3', 'sev4'])[((n - 1) % 4) + 1]::incident_severity,
  (ARRAY['investigating', 'identified', 'monitoring', 'resolved'])[((n - 1) % 4) + 1]::incident_status,
  now() - ((n * 19) || ' hours')::interval,
  CASE WHEN ((n - 1) % 4) = 3 THEN now() - ((n * 19 - 3) || ' hours')::interval END,
  (ARRAY[
    'Elevated API latency in the US East region.',
    'Delayed invoice generation for a subset of accounts.',
    'Webhook deliveries queued behind a slow consumer.',
    'Dashboard charts returned stale data for some customers.',
    'Event ingestion backlog after a storage node failover.'
  ])[((n - 1) % 5) + 1],
  jsonb_build_array(
    jsonb_build_object('at', now() - ((n * 19) || ' hours')::interval, 'message', 'Incident opened and on-call paged.'),
    jsonb_build_object('at', now() - ((n * 19 - 1) || ' hours')::interval, 'message', 'Root cause identified and mitigation started.'),
    jsonb_build_object('at', now() - ((n * 19 - 2) || ' hours')::interval, 'message', 'Service recovered; monitoring for recurrence.')
  ),
  ARRAY[
    (ARRAY['us-east-1', 'us-west-2', 'eu-west-1'])[((n - 1) % 3) + 1],
    (ARRAY['us-east-1', 'eu-west-1'])[((n - 1) % 2) + 1]
  ]
FROM generate_series(1, 12) AS n;

CREATE INDEX customers_owner_idx ON customers (owner_id);
CREATE INDEX contacts_customer_idx ON contacts (customer_id);
CREATE INDEX tickets_customer_status_idx ON tickets (customer_id, status);
CREATE INDEX tickets_opened_at_idx ON tickets (opened_at DESC);
CREATE INDEX invoices_subscription_status_idx ON invoices (subscription_id, status);
CREATE INDEX events_occurred_at_idx ON events (occurred_at DESC);
CREATE INDEX usage_daily_date_idx ON usage_daily (usage_date);
CREATE INDEX tasks_project_status_idx ON tasks (project_id, status);
CREATE INDEX audit_log_occurred_at_idx ON audit_log (occurred_at DESC);

DROP FUNCTION demo_uuid(text);

CREATE DATABASE analytics;
\connect analytics

CREATE OR REPLACE FUNCTION demo_uuid(seed text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$
  SELECT (
    substr(h, 1, 8) || '-' ||
    substr(h, 9, 4) || '-' ||
    '4' || substr(h, 14, 3) || '-' ||
    '8' || substr(h, 18, 3) || '-' ||
    substr(h, 21, 12)
  )::uuid
  FROM (SELECT md5(seed) AS h) AS digest
$$;

CREATE TABLE sessions (
  session_id uuid PRIMARY KEY,
  anonymous_id text NOT NULL,
  customer_id uuid,
  contact_id uuid,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  duration_seconds integer GENERATED ALWAYS AS (EXTRACT(EPOCH FROM (ended_at - started_at))::integer) STORED,
  landing_page text NOT NULL,
  referrer text,
  utm jsonb NOT NULL DEFAULT '{}'::jsonb,
  geo jsonb NOT NULL DEFAULT '{}'::jsonb,
  device jsonb NOT NULL DEFAULT '{}'::jsonb,
  page_view_count integer NOT NULL DEFAULT 0,
  converted boolean NOT NULL DEFAULT false
);

INSERT INTO sessions (session_id, anonymous_id, customer_id, contact_id, started_at, ended_at, landing_page, referrer, utm, geo, device, page_view_count, converted)
SELECT
  demo_uuid('session-' || n),
  'anon_' || substr(md5('anon-' || n), 1, 16),
  demo_uuid('customer-' || (((n - 1) % 40) + 1)),
  demo_uuid('contact-' || (((n - 1) % 120) + 1)),
  now() - ((n * 17) || ' minutes')::interval,
  CASE
    WHEN n % 17 = 0 THEN NULL
    ELSE now() - ((n * 17) || ' minutes')::interval + ((5 + (n % 25)) || ' minutes')::interval
  END,
  (ARRAY['/', '/pricing', '/docs/api', '/blog/incident-response', '/customers', '/security', '/integrations', '/changelog'])[((n - 1) % 8) + 1],
  (ARRAY['https://www.google.com/', 'https://www.linkedin.com/', 'https://news.ycombinator.com/', 'https://x.com/', NULL, NULL])[((n - 1) % 6) + 1],
  jsonb_build_object(
    'source', (ARRAY['google', 'linkedin', 'direct', 'newsletter'])[((n - 1) % 4) + 1],
    'medium', (ARRAY['organic', 'social', 'email', 'referral'])[((n - 1) % 4) + 1],
    'campaign', (ARRAY['q4-launch', 'support-ebook', 'none'])[((n - 1) % 3) + 1]
  ),
  jsonb_build_object(
    'country', (ARRAY['US', 'GB', 'DE', 'CA', 'AU', 'JP'])[((n - 1) % 6) + 1],
    'city', (ARRAY['Portland', 'London', 'Berlin', 'Toronto', 'Sydney', 'Tokyo'])[((n - 1) % 6) + 1]
  ),
  jsonb_build_object(
    'browser', (ARRAY['Chrome', 'Safari', 'Firefox', 'Edge'])[((n - 1) % 4) + 1],
    'os', (ARRAY['macOS', 'Windows', 'iOS', 'Android', 'Linux'])[((n - 1) % 5) + 1],
    'device_type', (ARRAY['desktop', 'mobile', 'tablet'])[((n - 1) % 3) + 1]
  ),
  1 + (n % 12),
  n % 7 = 0
FROM generate_series(1, 500) AS n;

CREATE TABLE page_views (
  view_id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  path text NOT NULL,
  title text NOT NULL,
  referrer text,
  duration_ms integer NOT NULL,
  scroll_depth numeric(5, 2) NOT NULL,
  occurred_at timestamptz NOT NULL,
  props jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO page_views (session_id, path, title, referrer, duration_ms, scroll_depth, occurred_at, props)
SELECT
  demo_uuid('session-' || (((n - 1) % 500) + 1)),
  (ARRAY['/', '/pricing', '/docs/api', '/docs/webhooks', '/customers', '/security', '/integrations', '/changelog'])[((n - 1) % 8) + 1],
  (ARRAY[
    'Northstar — Customer support that scales',
    'Pricing — Northstar',
    'API reference — Northstar',
    'Webhooks — Northstar',
    'Customer stories — Northstar',
    'Security and compliance — Northstar',
    'Integrations — Northstar',
    'Changelog — Northstar'
  ])[((n - 1) % 8) + 1],
  (ARRAY['https://www.google.com/', 'https://www.linkedin.com/', NULL, NULL, NULL])[((n - 1) % 5) + 1],
  800 + (n * 37) % 12000,
  round(((n * 13) % 100)::numeric, 2),
  now() - ((n * 3) || ' minutes')::interval,
  jsonb_build_object(
    'experiment', (ARRAY['control', 'treatment'])[((n - 1) % 2) + 1],
    'viewport', (ARRAY['desktop', 'mobile', 'tablet'])[((n - 1) % 3) + 1]
  )
FROM generate_series(1, 1500) AS n;

CREATE TABLE funnel_steps (
  funnel_key text NOT NULL,
  step_number smallint NOT NULL,
  name text NOT NULL,
  event_name text NOT NULL,
  PRIMARY KEY (funnel_key, step_number)
);

INSERT INTO funnel_steps (funnel_key, step_number, name, event_name) VALUES
  ('self_serve_trial', 1, 'Visited pricing', 'page_view.pricing'),
  ('self_serve_trial', 2, 'Started trial', 'trial.started'),
  ('self_serve_trial', 3, 'Invited teammate', 'user.invited'),
  ('self_serve_trial', 4, 'Connected integration', 'integration.connected'),
  ('support_upgrade', 1, 'Viewed usage', 'usage.viewed'),
  ('support_upgrade', 2, 'Opened upgrade dialog', 'upgrade.prompt_viewed'),
  ('support_upgrade', 3, 'Selected plan', 'plan.selected'),
  ('support_upgrade', 4, 'Completed checkout', 'subscription.created'),
  ('enterprise_lead', 1, 'Visited security page', 'page_view.security'),
  ('enterprise_lead', 2, 'Requested demo', 'lead.demo_requested'),
  ('enterprise_lead', 3, 'Completed discovery call', 'lead.discovery_completed'),
  ('enterprise_lead', 4, 'Signed contract', 'contract.signed');

CREATE TABLE daily_metrics (
  metric_date date NOT NULL,
  metric_key text NOT NULL,
  dimension jsonb NOT NULL DEFAULT '{}'::jsonb,
  value numeric(16, 2) NOT NULL,
  PRIMARY KEY (metric_date, metric_key)
);

INSERT INTO daily_metrics (metric_date, metric_key, dimension, value)
SELECT
  (current_date - d)::date,
  (ARRAY['signups', 'activations', 'mrr', 'churn', 'tickets_opened', 'api_calls'])[m],
  jsonb_build_object('plan', (ARRAY['starter', 'growth', 'scale', 'enterprise'])[((d + m) % 4) + 1]),
  CASE m
    WHEN 1 THEN round((42 + (d * 7) % 30)::numeric, 2)
    WHEN 2 THEN round((28 + (d * 5) % 24)::numeric, 2)
    WHEN 3 THEN round((184000 + d * 1250 + m * 400)::numeric, 2)
    WHEN 4 THEN round((2100 + (d * 19) % 1800)::numeric, 2)
    WHEN 5 THEN round((380 + (d * 13) % 220)::numeric, 2)
    ELSE round((2400000 + d * 17000 + (d % 7) * 9000)::numeric, 2)
  END
FROM generate_series(0, 59) AS d
CROSS JOIN generate_series(1, 6) AS m;

CREATE TABLE cohorts (
  cohort_month date NOT NULL,
  signup_week date NOT NULL,
  users integer NOT NULL,
  retained_d1 numeric(5, 2) NOT NULL,
  retained_d7 numeric(5, 2) NOT NULL,
  retained_d30 numeric(5, 2) NOT NULL,
  revenue numeric(12, 2) NOT NULL,
  PRIMARY KEY (cohort_month, signup_week)
);

INSERT INTO cohorts (cohort_month, signup_week, users, retained_d1, retained_d7, retained_d30, revenue)
SELECT
  (date_trunc('month', now()) - ((m || ' months')::interval))::date,
  (date_trunc('week', now()) - ((w || ' weeks')::interval))::date,
  120 + m * 17 + w * 9,
  round((62 - w * 3 - m * 0.5)::numeric, 2),
  round((41 - w * 2 - m * 0.4)::numeric, 2),
  round((24 - w * 1.5 - m * 0.3)::numeric, 2),
  round((7800 + m * 420 + w * 260)::numeric, 2)
FROM generate_series(0, 11) AS m
CROSS JOIN generate_series(0, 3) AS w;

CREATE TABLE experiment_assignments (
  experiment_key text NOT NULL,
  unit_id uuid NOT NULL,
  variant text NOT NULL,
  assigned_at timestamptz NOT NULL,
  converted boolean NOT NULL DEFAULT false,
  revenue numeric(12, 2) NOT NULL DEFAULT 0,
  PRIMARY KEY (experiment_key, unit_id)
);

INSERT INTO experiment_assignments (experiment_key, unit_id, variant, assigned_at, converted, revenue)
SELECT
  (ARRAY[
    'pricing_page_copy', 'onboarding_checklist', 'ticket_sidebar',
    'ai_summary', 'trial_length', 'upgrade_prompt',
    'search_ranking', 'webhook_ui'
  ])[((n - 1) % 8) + 1],
  demo_uuid('unit-' || n),
  (ARRAY['control', 'treatment'])[((n - 1) % 2) + 1],
  now() - ((n * 7) || ' hours')::interval,
  n % 7 = 0,
  round(((n % 13) * 17.5)::numeric, 2)
FROM generate_series(1, 300) AS n;

CREATE TABLE geo_regions (
  region_code text PRIMARY KEY,
  name text NOT NULL,
  country_code char(2) NOT NULL,
  population integer NOT NULL,
  timezone text NOT NULL,
  coordinates jsonb NOT NULL
);

INSERT INTO geo_regions (region_code, name, country_code, population, timezone, coordinates)
SELECT
  (ARRAY[
    'us-east-1', 'us-west-2', 'ca-central-1', 'eu-west-1', 'eu-central-1',
    'eu-north-1', 'ap-southeast-1', 'ap-northeast-1', 'ap-south-1',
    'sa-east-1', 'uk-south-1', 'us-central-1', 'eu-west-2', 'eu-west-3',
    'ap-southeast-2', 'ap-east-1', 'me-south-1', 'af-south-1',
    'us-east-2', 'ca-west-1'
  ])[n],
  (ARRAY[
    'N. Virginia', 'Oregon', 'Montreal', 'Ireland', 'Frankfurt',
    'Stockholm', 'Singapore', 'Tokyo', 'Mumbai',
    'Sao Paulo', 'London', 'Iowa', 'Paris', 'Marseille',
    'Sydney', 'Hong Kong', 'Bahrain', 'Cape Town',
    'Ohio', 'Calgary'
  ])[n],
  (ARRAY['US', 'US', 'CA', 'IE', 'DE', 'SE', 'SG', 'JP', 'IN', 'BR',
         'GB', 'US', 'FR', 'FR', 'AU', 'HK', 'BH', 'ZA', 'US', 'CA'])[n],
  800000 + n * 375000,
  (ARRAY['America/New_York', 'America/Los_Angeles', 'America/Toronto',
         'Europe/Dublin', 'Europe/Berlin', 'Europe/Stockholm',
         'Asia/Singapore', 'Asia/Tokyo', 'Asia/Kolkata',
         'America/Sao_Paulo', 'Europe/London', 'America/Chicago',
         'Europe/Paris', 'Europe/Paris', 'Australia/Sydney',
         'Asia/Hong_Kong', 'Asia/Bahrain', 'Africa/Johannesburg',
         'America/New_York', 'America/Edmonton'])[n],
  jsonb_build_object(
    'lat', round((38.0 + n * 1.7)::numeric, 3),
    'lng', round((-120.0 + n * 7.3)::numeric, 3)
  )
FROM generate_series(1, 20) AS n;

CREATE TABLE query_performance (
  query_id uuid PRIMARY KEY,
  query_text text NOT NULL,
  engine text NOT NULL,
  duration_range int4range NOT NULL,
  rows_returned bigint NOT NULL,
  cache_hit boolean NOT NULL,
  captured_at timestamptz NOT NULL,
  plan jsonb NOT NULL
);

INSERT INTO query_performance (query_id, query_text, engine, duration_range, rows_returned, cache_hit, captured_at, plan)
SELECT
  demo_uuid('query-' || n),
  (ARRAY[
    'SELECT * FROM tickets WHERE customer_id = $1 ORDER BY opened_at DESC LIMIT 50',
    'SELECT plan_code, sum(mrr) FROM subscriptions GROUP BY plan_code',
    'SELECT date_trunc(''day'', occurred_at), count(*) FROM events GROUP BY 1',
    'SELECT * FROM usage_daily WHERE usage_date >= $1',
    'SELECT * FROM invoices WHERE status = $1 ORDER BY due_on',
    'SELECT * FROM tasks WHERE project_id = $1 AND status <> $2'
  ])[((n - 1) % 6) + 1],
  (ARRAY['postgres', 'mysql', 'sqlite'])[((n - 1) % 3) + 1],
  int4range(
    50 + (n * 13) % 2000,
    50 + (n * 13) % 2000 + 100 + (n % 400),
    '[)'
  ),
  1 + (n * 37) % 50000,
  n % 3 = 0,
  now() - ((n * 11) || ' minutes')::interval,
  jsonb_build_object(
    'node', (ARRAY['Seq Scan', 'Index Scan', 'Bitmap Heap Scan'])[((n - 1) % 3) + 1],
    'cost', round((n * 0.37)::numeric, 2),
    'parallel', n % 5 = 0
  )
FROM generate_series(1, 200) AS n;

CREATE TABLE revenue_daily (
  revenue_date date PRIMARY KEY,
  new_mrr numeric(12, 2) NOT NULL,
  expansion_mrr numeric(12, 2) NOT NULL,
  churned_mrr numeric(12, 2) NOT NULL,
  net_mrr numeric(12, 2) NOT NULL
);

INSERT INTO revenue_daily (revenue_date, new_mrr, expansion_mrr, churned_mrr, net_mrr)
SELECT
  (current_date - d)::date,
  round((1200 + (d * 37) % 900)::numeric, 2),
  round((300 + (d * 19) % 500)::numeric, 2),
  round((150 + (d * 11) % 350)::numeric, 2),
  round((1200 + (d * 37) % 900 + 300 + (d * 19) % 500 - 150 - (d * 11) % 350)::numeric, 2)
FROM generate_series(0, 59) AS d;

DROP FUNCTION demo_uuid(text);
