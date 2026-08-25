-- Phase 1: Contract-Centric Cadence Model Schema
-- Run this migration to create the new tables and schema
-- Backup your database first!

-- ============================================
-- Step 1: Modify existing tables
-- ============================================

-- Add coach departure tracking
ALTER TABLE coaches ADD COLUMN left_date TEXT DEFAULT NULL;
ALTER TABLE coaches ADD COLUMN reason TEXT DEFAULT '';

-- Add team assignment denormalization to contracts (for speed)
ALTER TABLE contracts ADD COLUMN assigned_team_id INTEGER DEFAULT NULL;

-- ============================================
-- Step 2: Create new tables
-- ============================================

-- Teams: groups of coaches working together
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  lead_coach_id TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(lead_coach_id) REFERENCES coaches(id)
);
CREATE INDEX IF NOT EXISTS idx_team_active ON teams(active);
CREATE INDEX IF NOT EXISTS idx_team_name ON teams(name);

-- Team Members: maps coaches to teams with history tracking
CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  coach_id TEXT NOT NULL,
  role TEXT DEFAULT 'member' CHECK(role IN ('lead', 'member')),
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at TEXT,
  UNIQUE(team_id, coach_id, left_at),
  FOREIGN KEY(team_id) REFERENCES teams(id),
  FOREIGN KEY(coach_id) REFERENCES coaches(id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_coach ON team_members(coach_id);
CREATE INDEX IF NOT EXISTS idx_team_members_active ON team_members(left_at);

-- Cadence Cycles: THE SOURCE OF TRUTH for what work needs to happen
-- Each cycle is independent of who does it
CREATE TABLE IF NOT EXISTS cadence_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  sequence_num INTEGER NOT NULL,
  total_in_cycle INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'fulfilled', 'overdue', 'cancelled')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(contract_id, sequence_num),
  FOREIGN KEY(contract_id) REFERENCES contracts(id)
);
CREATE INDEX IF NOT EXISTS idx_cadence_contract ON cadence_cycles(contract_id);
CREATE INDEX IF NOT EXISTS idx_cadence_due ON cadence_cycles(due_date);
CREATE INDEX IF NOT EXISTS idx_cadence_status ON cadence_cycles(status);
CREATE INDEX IF NOT EXISTS idx_cadence_contract_status ON cadence_cycles(contract_id, status);

-- Visit Fulfillments: IMMUTABLE EVENT LOG
-- Records who actually did the work and when
-- Append-only, never edited or deleted
CREATE TABLE IF NOT EXISTS visit_fulfillments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cadence_cycle_id INTEGER NOT NULL,
  coach_id TEXT,
  fulfilled_on TEXT NOT NULL,
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(cadence_cycle_id) REFERENCES cadence_cycles(id),
  FOREIGN KEY(coach_id) REFERENCES coaches(id)
);
CREATE INDEX IF NOT EXISTS idx_fulfillment_cycle ON visit_fulfillments(cadence_cycle_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_coach ON visit_fulfillments(coach_id);
CREATE INDEX IF NOT EXISTS idx_fulfillment_date ON visit_fulfillments(fulfilled_on);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fulfillment_one_per_cycle ON visit_fulfillments(cadence_cycle_id);

-- Contract-Team Assignments: which team is responsible for a contract
CREATE TABLE IF NOT EXISTS contract_team_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notes TEXT DEFAULT '',
  UNIQUE(contract_id),
  FOREIGN KEY(contract_id) REFERENCES contracts(id),
  FOREIGN KEY(team_id) REFERENCES teams(id)
);
CREATE INDEX IF NOT EXISTS idx_assignment_contract ON contract_team_assignments(contract_id);
CREATE INDEX IF NOT EXISTS idx_assignment_team ON contract_team_assignments(team_id);

-- Schedule Fulfillment Queue: what needs to be scheduled from the 2026 sheet resync
CREATE TABLE IF NOT EXISTS schedule_fulfillments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cadence_cycle_id INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  sheet_week TEXT NOT NULL,
  sheet_coach_hint TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'scheduled', 'fulfilled', 'cancelled')),
  scheduled_for_coach_id TEXT,
  scheduled_on TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(cadence_cycle_id) REFERENCES cadence_cycles(id),
  FOREIGN KEY(team_id) REFERENCES teams(id),
  FOREIGN KEY(scheduled_for_coach_id) REFERENCES coaches(id)
);
CREATE INDEX IF NOT EXISTS idx_sched_fulfillment_cycle ON schedule_fulfillments(cadence_cycle_id);
CREATE INDEX IF NOT EXISTS idx_sched_fulfillment_team ON schedule_fulfillments(team_id);
CREATE INDEX IF NOT EXISTS idx_sched_fulfillment_status ON schedule_fulfillments(status);

PRAGMA foreign_keys = ON;

-- ============================================
-- Step 3: Add migration tracking
-- ============================================

INSERT OR IGNORE INTO meta(key, value) VALUES 
  ('schema_version', '2'),
  ('phase1_migration_date', CURRENT_TIMESTAMP);

