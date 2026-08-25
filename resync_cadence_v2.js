/**
 * Resync Preview v2: Cadence-Centric Schedule Matching
 * 
 * This is the NEW implementation of resyncPreview2026() that uses:
 * 1. Cadence cycles as source of truth
 * 2. Team assignments (not individual coaches)
 * 3. Priority-based matching (oldest pending cycle first)
 * 4. Schedule fulfillment queuing (not visit creation)
 */

const CadenceModel = require('./cadence_model');

/**
 * Main resync logic: match 2026 sheet to cadence cycles
 */
function resyncPreview2026Cadence(db, csvData) {
  const cadence = new CadenceModel(db);

  // Parse the CSV data
  const parsed = parseScheduleCSV(csvData);
  if (parsed.error) return { error: parsed.error, imported: false };

  const recon = {
    imported: true,
    error: null,
    plan: [],
    summary: {
      matched: 0,
      extra_visits: 0,
      unmatched_entries: 0,
      teams_involved: []
    },
    details: []
  };

  // Get all active clients
  const clients = db.prepare(`SELECT id, name, norm FROM clients WHERE status = 'active'`).all();
  const clientByName = new Map();
  clients.forEach(c => {
    clientByName.set(c.name.toLowerCase(), c);
    clientByName.set(c.norm, c);
  });

  // Group sheet entries by client
  const byClient = new Map();
  for (const entry of parsed.entries) {
    const clientKey = entry.client.toLowerCase();
    const client = clientByName.get(clientKey);
    
    if (!client) {
      recon.details.push({
        type: 'unmatched_client',
        sheet_entry: entry,
        reason: `Client "${entry.client}" not found in system`
      });
      recon.summary.unmatched_entries++;
      continue;
    }

    if (!byClient.has(client.id)) {
      byClient.set(client.id, []);
    }
    byClient.get(client.id).push({ ...entry, client_id: client.id, client_obj: client });
  }

  // Process each client's entries
  for (const [clientId, entries] of byClient) {
    const clientName = entries[0].client_obj.name;
    
    // Get contracts for this client
    const contracts = db.prepare(`
      SELECT id, program, assigned_team_id
      FROM contracts
      WHERE client_id = ? AND archived_at IS NULL AND status = 'active'
    `).all(clientId);

    if (contracts.length === 0) {
      for (const entry of entries) {
        recon.details.push({
          type: 'no_contract',
          client_name: clientName,
          sheet_entry: entry,
          reason: `No active contract for this client`
        });
        recon.summary.unmatched_entries++;
      }
      continue;
    }

    // For now, use the first contract (assume single active program per client)
    const contract = contracts[0];
    const teamId = contract.assigned_team_id;

    if (!teamId) {
      for (const entry of entries) {
        recon.details.push({
          type: 'no_team_assignment',
          client_name: clientName,
          contract_id: contract.id,
          sheet_entry: entry,
          reason: `Contract has no team assignment`
        });
        recon.summary.unmatched_entries++;
      }
      continue;
    }

    // Get pending cycles for this contract
    const pendingCycles = cadence.getPendingCycles(contract.id);
    if (pendingCycles.length === 0) {
      for (const entry of entries) {
        recon.details.push({
          type: 'no_pending_cycles',
          client_name: clientName,
          contract_id: contract.id,
          sheet_entry: entry,
          reason: `All cadence cycles already fulfilled`
        });
        recon.summary.unmatched_entries++;
      }
      continue;
    }

    // Sort entries by week (should match in order)
    entries.sort((a, b) => a.week.localeCompare(b.week));

    // NEW: Match using priority-based tryMatch
    const claimed = new Set(); // Track which cycles we've already matched
    
    for (const entry of entries) {
      // Find best cycle for this sheet entry
      const cycleToMatch = tryMatchCycleByCadence(
        entry.week,
        pendingCycles.filter(c => !claimed.has(c.id))
      );

      if (cycleToMatch) {
        claimed.add(cycleToMatch.id);
        
        // Queue a schedule fulfillment
        cadence.queueScheduleFulfillment(
          cycleToMatch.id,
          teamId,
          entry.week,
          entry.coach
        );

        recon.summary.matched++;
        recon.details.push({
          type: 'matched',
          client_name: clientName,
          cycle: `${cycleToMatch.sequence_num} of ${cycleToMatch.total_in_cycle}`,
          sheet_week: entry.week,
          cycle_due: cycleToMatch.due_date,
          assigned_team: teamId
        });
      } else {
        // This is genuinely extra work not part of cadence
        recon.summary.extra_visits++;
        recon.details.push({
          type: 'extra_visit',
          client_name: clientName,
          sheet_entry: entry,
          reason: `No matching cadence cycle for this sheet week`
        });
      }
    }

    if (!recon.summary.teams_involved.includes(teamId)) {
      recon.summary.teams_involved.push(teamId);
    }
  }

  // Build summary
  recon.summary.total_sheet_entries = parsed.entries.length;
  recon.summary.total_matched = recon.summary.matched;
  recon.summary.total_unmatched = recon.summary.unmatched_entries + recon.summary.extra_visits;

  return recon;
}

/**
 * NEW: Priority-based matching logic
 * Matches a sheet week to cycles using:
 * 1. First pass: find oldest unfulfilled cycle
 * 2. Fallback: find closest by due date
 */
function tryMatchCycleByCadence(sheetWeek, availableCycles) {
  if (!availableCycles.length) return null;

  // Sort by sequence number (oldest first)
  const sorted = [...availableCycles].sort((a, b) => a.sequence_num - b.sequence_num);

  // Priority 1: Return oldest cycle that's reasonably close to sheet week
  for (const cycle of sorted) {
    if (isReasonablyClose(sheetWeek, cycle.due_date)) {
      return cycle;
    }
  }

  // Priority 2: If no close match, return oldest cycle anyway
  // (late scheduling is better than orphaning work)
  return sorted[0];
}

/**
 * Check if sheet week is within 30 days of due date
 */
function isReasonablyClose(sheetWeek, dueDate) {
  try {
    const sheet = new Date(sheetWeek);
    const due = new Date(dueDate);
    const diffMs = Math.abs(sheet - due);
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= 30;
  } catch (e) {
    return false;
  }
}

/**
 * Parse schedule CSV data
 * Expected format: Client, Week, Coach, ...
 */
function parseScheduleCSV(csvText) {
  if (!csvText || typeof csvText !== 'string') {
    return { error: 'No CSV data provided', entries: [] };
  }

  const lines = csvText.trim().split('\n');
  if (lines.length < 2) {
    return { error: 'CSV appears empty', entries: [] };
  }

  const entries = [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());

  // Find column indices
  const clientIdx = headers.findIndex(h => h.includes('client') || h.includes('company'));
  const weekIdx = headers.findIndex(h => h.includes('week') || h.includes('date'));
  const coachIdx = headers.findIndex(h => h.includes('coach'));

  if (clientIdx === -1 || weekIdx === -1) {
    return { error: 'Missing required columns (Client, Week)', entries: [] };
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim());
    if (parts.length <= Math.max(clientIdx, weekIdx)) continue;

    entries.push({
      client: parts[clientIdx],
      week: parts[weekIdx],
      coach: coachIdx >= 0 ? parts[coachIdx] : null
    });
  }

  return { entries, error: null };
}

module.exports = {
  resyncPreview2026Cadence,
  tryMatchCycleByCadence,
  parseScheduleCSV
};
