-- Migration 0001: Initial schema for homes, members, bills, and shares

CREATE TABLE homes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Prevents empty or whitespace-only home names from being created.
  CONSTRAINT ck_homes_name_not_empty CHECK (length(trim(name)) > 0)
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Prevents members from referencing non-existent homes and cascades deletions.
  CONSTRAINT fk_members_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE,
  -- Prevents empty or whitespace-only member names.
  CONSTRAINT ck_members_name_not_empty CHECK (length(trim(name)) > 0),
  -- Prevents duplicate sequence positions within the same home, enforcing strict ordering.
  CONSTRAINT uq_members_home_position UNIQUE (home_id, position)
);

CREATE TABLE bills (
  id TEXT PRIMARY KEY,
  home_id TEXT NOT NULL,
  title TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Prevents bills from referencing non-existent homes.
  CONSTRAINT fk_bills_home FOREIGN KEY (home_id) REFERENCES homes(id) ON DELETE CASCADE,
  -- Prevents empty or whitespace-only bill titles.
  CONSTRAINT ck_bills_title_not_empty CHECK (length(trim(title)) > 0),
  -- Prevents zero or negative bill totals from being inserted at the database level.
  CONSTRAINT ck_bills_total_cents CHECK (total_cents > 0)
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  bill_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  paid_at TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Prevents shares from referencing non-existent bills.
  CONSTRAINT fk_shares_bill FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
  -- Prevents shares from referencing non-existent members.
  CONSTRAINT fk_shares_member FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE,
  -- Prevents assigning multiple shares of the same bill to the same member.
  CONSTRAINT uq_shares_bill_member UNIQUE (bill_id, member_id),
  -- Prevents negative share amounts; allows 0 cents when total is less than member count.
  CONSTRAINT ck_shares_amount_cents CHECK (amount_cents >= 0),
  -- Prevents inconsistent payment state: paid_at and idempotency_key must either both be set or both be NULL.
  CONSTRAINT ck_shares_paid_consistent CHECK ((paid_at IS NULL) = (idempotency_key IS NULL))
);
