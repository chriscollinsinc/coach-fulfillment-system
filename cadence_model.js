/**
 * Cadence-Centric Business Logic Module
 * 
 * Core functions for working with the new contract/cadence/fulfillment model.
 * This module provides a clear API for:
 * - Cadence cycle generation and management
 * - Team and coach assignment
 * - Schedule matching and fulfillment queuing
 * - Immutable fulfillment event logging
 */

const Database = require('better-sqlite3');

class CadenceModel {
  constructor(db) {
    this.db = db;
    this.db.pragma('foreign_keys = ON');
  }

  // ============================================
  // CADENCE CYCLE OPERATIONS
  // ============================================

  /**
   * Generate cadence cycles for a new contract
   * Creates all cycles upfront based on program type
   */
  generateCadenceCycles(contractId, program, startDate, clientId) {
    const cycleCount = this.getProgramCycleCount(program);
    const cycles = [];

    const insert = this.db.prepare(`
      INSERT INTO cadence_cycles 
        (contract_id, sequence_num, total_in_cycle, due_date, status)
      VALUES (?, ?, ?, ?, 'pending')
    `);

    for (let seq = 1; seq <= cycleCount; seq++) {
      const dueDate = this.calculateCycleDueDate(startDate, seq, program, cycleCount);
      const result = insert.run(contractId, seq, cycleCount, dueDate);
      cycles.push({
        id: result.lastInsertRowid,
        contractId,
        seq,
        total: cycleCount,
        dueDate,
        status: 'pending'
      });
    }

    return cycles;
  }

  /**
   * Get all cycles for a contract
   */
  getContractCycles(contractId, statusFilter = null) {
    let sql = `
      SELECT id, contract_id, sequence_num, total_in_cycle, due_date, status, created_at
      FROM cadence_cycles
      WHERE contract_id = ?
      ORDER BY sequence_num ASC
    `;
    const params = [contractId];

    if (statusFilter) {
      sql += ` AND status = ?`;
      params.push(statusFilter);
    }

    return this.db.prepare(sql).all(...params);
  }

  /**
   * Get pending cycles (not yet fulfilled) for a contract
   */
  getPendingCycles(contractId) {
    return this.getContractCycles(contractId, 'pending');
  }

  /**
   * Get oldest pending cycle for a contract
   * Used in matching logic - we prefer to fulfill older cycles first
   */
  getOldestPendingCycle(contractId) {
    return this.db.prepare(`
      SELECT id, contract_id, sequence_num, total_in_cycle, due_date, status
      FROM cadence_cycles
      WHERE contract_id = ? AND status = 'pending'
      ORDER BY sequence_num ASC
      LIMIT 1
    `).get(contractId);
  }

  /**
   * Mark a cycle as fulfilled
   */
  markCycleFulfilled(cycleId) {
    this.db.prepare(`
      UPDATE cadence_cycles
      SET status = 'fulfilled'
      WHERE id = ?
    `).run(cycleId);
  }

  /**
   * Get all pending cycles across all contracts
   */
  getAllPendingCycles() {
    return this.db.prepare(`
      SELECT cc.id, cc.contract_id, cc.sequence_num, cc.total_in_cycle, cc.due_date,
             c.client_id, cl.name as client_name, c.program
      FROM cadence_cycles cc
      JOIN contracts c ON cc.contract_id = c.id
      JOIN clients cl ON c.client_id = cl.id
      WHERE cc.status = 'pending'
      ORDER BY cc.due_date ASC
    `).all();
  }

  // ============================================
  // FULFILLMENT EVENT LOGGING (Immutable)
  // ============================================

  /**
   * Log a fulfillment event for a cycle
   * This is append-only and immutable - once logged, it cannot be edited or deleted
   */
  logFulfillmentEvent(cycleId, coachId, fulfilledDate, notes = '') {
    // Ensure the cycle exists
    const cycle = this.db.prepare(`SELECT id FROM cadence_cycles WHERE id = ?`).get(cycleId);
    if (!cycle) {
      throw new Error(`Cycle ${cycleId} not found`);
    }

    // Ensure only one fulfillment per cycle
    const existing = this.db.prepare(`
      SELECT id FROM visit_fulfillments WHERE cadence_cycle_id = ?
    `).get(cycleId);
    if (existing) {
      throw new Error(`Cycle ${cycleId} already has a fulfillment event`);
    }

    const result = this.db.prepare(`
      INSERT INTO visit_fulfillments (cadence_cycle_id, coach_id, fulfilled_on, notes)
      VALUES (?, ?, ?, ?)
    `).run(cycleId, coachId || 'system', fulfilledDate, notes);

    // Mark cycle as fulfilled
    this.markCycleFulfilled(cycleId);

    return {
      id: result.lastInsertRowid,
      cycleId,
      coachId: coachId || 'system',
      fulfilledDate,
      notes
    };
  }

  /**
   * Get fulfillment events for a cycle
   */
  getCycleFulfillment(cycleId) {
    return this.db.prepare(`
      SELECT id, cadence_cycle_id, coach_id, fulfilled_on, notes, created_at
      FROM visit_fulfillments
      WHERE cadence_cycle_id = ?
    `).get(cycleId);
  }

  /**
   * Get all fulfillments for a contract
   */
  getContractFulfillments(contractId) {
    return this.db.prepare(`
      SELECT vf.id, vf.cadence_cycle_id, cc.sequence_num, cc.total_in_cycle,
             vf.coach_id, vf.fulfilled_on, vf.notes, vf.created_at
      FROM visit_fulfillments vf
      JOIN cadence_cycles cc ON vf.cadence_cycle_id = cc.id
      WHERE cc.contract_id = ?
      ORDER BY cc.sequence_num ASC
    `).all(contractId);
  }

  // ============================================
  // TEAM MANAGEMENT
  // ============================================

  /**
   * Create a team
   */
  createTeam(name, leadCoachId) {
    const result = this.db.prepare(`
      INSERT INTO teams (name, lead_coach_id)
      VALUES (?, ?)
    `).run(name, leadCoachId);

    // Add lead coach as a member
    if (leadCoachId) {
      this.db.prepare(`
        INSERT INTO team_members (team_id, coach_id, role)
        VALUES (?, ?, 'lead')
      `).run(result.lastInsertRowid, leadCoachId);
    }

    return {
      id: result.lastInsertRowid,
      name,
      leadCoachId
    };
  }

  /**
   * Get a team by ID with active members
   */
  getTeamWithMembers(teamId) {
    const team = this.db.prepare(`
      SELECT id, name, lead_coach_id, active
      FROM teams
      WHERE id = ?
    `).get(teamId);

    if (!team) return null;

    const members = this.db.prepare(`
      SELECT c.id, c.name, tm.role, tm.joined_at
      FROM team_members tm
      JOIN coaches c ON tm.coach_id = c.id
      WHERE tm.team_id = ? AND tm.left_at IS NULL
      ORDER BY tm.joined_at ASC
    `).all(teamId);

    return { ...team, members };
  }

  /**
   * Add coach to team
   */
  addCoachToTeam(teamId, coachId, role = 'member') {
    const result = this.db.prepare(`
      INSERT INTO team_members (team_id, coach_id, role)
      VALUES (?, ?, ?)
    `).run(teamId, coachId, role);

    return result.lastInsertRowid;
  }

  /**
   * Remove coach from team (soft delete with left_at timestamp)
   */
  removeCoachFromTeam(teamId, coachId) {
    return this.db.prepare(`
      UPDATE team_members
      SET left_at = CURRENT_TIMESTAMP
      WHERE team_id = ? AND coach_id = ? AND left_at IS NULL
    `).run(teamId, coachId);
  }

  /**
   * Get active coaches in a team
   */
  getActiveTeamMembers(teamId) {
    return this.db.prepare(`
      SELECT c.id, c.name, c.active, tm.role
      FROM team_members tm
      JOIN coaches c ON tm.coach_id = c.id
      WHERE tm.team_id = ? AND tm.left_at IS NULL AND c.active = 1
      ORDER BY tm.role DESC, c.name ASC
    `).all(teamId);
  }

  // ============================================
  // CONTRACT-TEAM ASSIGNMENT
  // ============================================

  /**
   * Assign a contract to a team
   */
  assignContractToTeam(contractId, teamId, notes = '') {
    // Remove any existing assignment
    this.db.prepare(`DELETE FROM contract_team_assignments WHERE contract_id = ?`)
      .run(contractId);

    // Create new assignment
    const result = this.db.prepare(`
      INSERT INTO contract_team_assignments (contract_id, team_id, notes)
      VALUES (?, ?, ?)
    `).run(contractId, teamId, notes);

    // Denormalize to contracts table for speed
    this.db.prepare(`UPDATE contracts SET assigned_team_id = ? WHERE id = ?`)
      .run(teamId, contractId);

    return {
      id: result.lastInsertRowid,
      contractId,
      teamId
    };
  }

  /**
   * Get team assigned to a contract
   */
  getContractTeam(contractId) {
    const assignment = this.db.prepare(`
      SELECT team_id FROM contract_team_assignments WHERE contract_id = ?
    `).get(contractId);

    if (!assignment) return null;

    return this.getTeamWithMembers(assignment.team_id);
  }

  /**
   * Get all contracts assigned to a team
   */
  getTeamContracts(teamId) {
    return this.db.prepare(`
      SELECT c.id, c.client_id, cl.name as client_name, c.program,
             cta.assigned_at
      FROM contract_team_assignments cta
      JOIN contracts c ON cta.contract_id = c.id
      JOIN clients cl ON c.client_id = cl.id
      WHERE cta.team_id = ?
      ORDER BY cl.name ASC
    `).all(teamId);
  }

  // ============================================
  // COACH DEPARTURE HANDLING
  // ============================================

  /**
   * Mark coach as departed
   * Removes them from all teams but keeps historical data
   */
  departCoach(coachId, reason = '') {
    // Mark coach as inactive
    this.db.prepare(`
      UPDATE coaches
      SET active = 0, left_date = CURRENT_TIMESTAMP, reason = ?
      WHERE id = ?
    `).run(reason, coachId);

    // Remove from all teams
    this.db.prepare(`
      UPDATE team_members
      SET left_at = CURRENT_TIMESTAMP
      WHERE coach_id = ? AND left_at IS NULL
    `).run(coachId);

    // Get their pending assignments to escalate
    const pendingFulfillments = this.db.prepare(`
      SELECT sf.id, sf.cadence_cycle_id, sf.team_id
      FROM schedule_fulfillments sf
      WHERE sf.scheduled_for_coach_id = ? AND sf.status IN ('pending', 'scheduled')
    `).all(coachId);

    // Mark fulfillments as needing reassignment
    for (const fulfillment of pendingFulfillments) {
      this.db.prepare(`
        UPDATE schedule_fulfillments
        SET status = 'pending', scheduled_for_coach_id = NULL
        WHERE id = ?
      `).run(fulfillment.id);
    }

    return {
      coachId,
      departedAt: new Date().toISOString(),
      pendingReassignments: pendingFulfillments.length
    };
  }

  // ============================================
  // SCHEDULE MATCHING & FULFILLMENT QUEUING
  // ============================================

  /**
   * Queue a schedule fulfillment (for 2026 sheet resync)
   * Matches a sheet entry to a cadence cycle and queues for assignment
   */
  queueScheduleFulfillment(cycleId, teamId, sheetWeek, coachHint = null) {
    const result = this.db.prepare(`
      INSERT INTO schedule_fulfillments 
        (cadence_cycle_id, team_id, sheet_week, sheet_coach_hint, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(cycleId, teamId, sheetWeek, coachHint);

    return {
      id: result.lastInsertRowid,
      cycleId,
      teamId,
      sheetWeek,
      status: 'pending'
    };
  }

  /**
   * Get all queued fulfillments for a team
   */
  getTeamQueuedFulfillments(teamId) {
    return this.db.prepare(`
      SELECT sf.id, sf.cadence_cycle_id, sf.sheet_week, sf.sheet_coach_hint,
             cc.sequence_num, cc.due_date, cc.total_in_cycle,
             c.id as contract_id, cl.name as client_name
      FROM schedule_fulfillments sf
      JOIN cadence_cycles cc ON sf.cadence_cycle_id = cc.id
      JOIN contracts c ON cc.contract_id = c.id
      JOIN clients cl ON c.client_id = cl.id
      WHERE sf.team_id = ? AND sf.status = 'pending'
      ORDER BY cc.due_date ASC
    `).all(teamId);
  }

  /**
   * Mark a queued fulfillment as scheduled
   */
  scheduleFulfillment(fulfillmentQueueId, coachId) {
    this.db.prepare(`
      UPDATE schedule_fulfillments
      SET status = 'scheduled', scheduled_for_coach_id = ?, scheduled_on = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(coachId, fulfillmentQueueId);
  }

  // ============================================
  // HELPER FUNCTIONS
  // ============================================

  /**
   * Get cycle count for a program type
   */
  getProgramCycleCount(program) {
    const counts = {
      'Quarterly': 4,
      'Bi-Annual': 2,
      'Annual': 1,
      'Monthly': 12,
      '6 Visits Monthly': 6,
    };
    return counts[program] || 4;
  }

  /**
   * Calculate due date for a specific cycle
   */
  calculateCycleDueDate(startDate, cycleNum, program, cycleCount) {
    const start = new Date(startDate);
    const daysPerCycle = this.getDaysPerCycle(program) / cycleCount;
    const dueDate = new Date(start);
    dueDate.setDate(dueDate.getDate() + daysPerCycle * (cycleNum - 1));
    return dueDate.toISOString().split('T')[0];
  }

  /**
   * Get total days in program cycle
   */
  getDaysPerCycle(program) {
    const days = {
      'Quarterly': 365,
      'Bi-Annual': 365,
      'Annual': 365,
      'Monthly': 365,
      '6 Visits Monthly': 365,
    };
    return days[program] || 365;
  }

  /**
   * Check if a date is reasonably close to a due date (within 30 days)
   */
  isReasonablyClose(sheetWeek, dueDate) {
    const sheet = new Date(sheetWeek);
    const due = new Date(dueDate);
    const diffMs = Math.abs(sheet - due);
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= 30;
  }
}

module.exports = CadenceModel;
