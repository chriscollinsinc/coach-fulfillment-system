#!/usr/bin/env node
/**
 * Backfill Script: Convert existing visits to cadence_cycles
 * 
 * This script:
 * 1. For each contract, reconstructs its cadence cycles from existing visits
 * 2. Creates cadence_cycle records with proper sequence numbers
 * 3. Creates visit_fulfillment records for completed visits
 * 4. Validates data integrity
 * 
 * Usage: node backfill_cadence_cycles.js [--dry-run] [--contract-id=123]
 */

const fs = require('fs');
const Database = require('better-sqlite3');

const dryRun = process.argv.includes('--dry-run');
const contractIdArg = process.argv.find(a => a.startsWith('--contract-id='));
const targetContractId = contractIdArg ? +contractIdArg.split('=')[1] : null;

const dbPath = process.env.DB_PATH || './data/coach.db';
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

console.log(`🔄 Backfill Cadence Cycles${dryRun ? ' [DRY RUN]' : ''}`);
console.log(`📊 Database: ${dbPath}`);
console.log('');

// ============================================
// Helper: Parse cycle label like "1 of 4"
// ============================================
function parseCycle(cycleStr) {
  if (!cycleStr) return null;
  const match = /^(\d+)\s+of\s+(\d+)/i.exec(cycleStr);
  if (!match) return null;
  return { seq: +match[1], total: +match[2] };
}

// ============================================
// Helper: Calculate due date from program
// ============================================
function calculateDueDate(startDate, cycleNum, program, cycleCount) {
  const start = new Date(startDate);
  if (!start) return null;
  
  const programs = {
    'Quarterly': 90,
    'Bi-Annual': 180,
    'Annual': 365,
    'Monthly': 30,
    '6 Visits Monthly': 30,
  };
  
  const daysPerCycle = (programs[program] || 90) / (cycleCount || 1);
  const dueDate = new Date(start);
  dueDate.setDate(dueDate.getDate() + daysPerCycle * (cycleNum - 1));
  
  return dueDate.toISOString().split('T')[0];
}

// ============================================
// Main Backfill Logic
// ============================================

try {
  // Step 1: Get all contracts to process
  let contracts = db.prepare(`
    SELECT id, client_id, program, visits, start_date 
    FROM contracts 
    WHERE archived_at IS NULL
  `).all();
  
  if (targetContractId) {
    contracts = contracts.filter(c => c.id === targetContractId);
    console.log(`🎯 Targeting contract ID: ${targetContractId}`);
  }
  
  console.log(`📦 Found ${contracts.length} contracts to backfill\n`);
  
  let totalCyclesCreated = 0;
  let totalFulfillmentsCreated = 0;
  let errorsFound = 0;
  
  // Step 2: For each contract, create cadence cycles
  for (const contract of contracts) {
    const contractId = contract.id;
    const clientId = contract.client_id;
    const program = contract.program || '';
    const startDate = contract.start_date;
    
    console.log(`\n📋 Contract ${contractId} (Client: ${clientId}, Program: ${program})`);
    
    // Get all visits for this contract
    const visits = db.prepare(`
      SELECT id, cycle, due, completed, completed_on, cal_coach, sched_hist
      FROM visits
      WHERE client_id = ? OR (client = (SELECT name FROM clients WHERE id = ?))
      ORDER BY due ASC
    `).all(clientId, clientId);
    
    if (visits.length === 0) {
      console.log(`  ⚠️  No visits found for this contract`);
      continue;
    }
    
    // Parse cycles from existing visits
    const cycleMap = new Map(); // seq → {cycle_label, visits: [...]}
    
    for (const visit of visits) {
      const cycleInfo = parseCycle(visit.cycle);
      if (!cycleInfo) {
        console.log(`  ⚠️  Could not parse cycle from visit ${visit.id}: "${visit.cycle}"`);
        continue;
      }
      
      const key = `${cycleInfo.seq}_of_${cycleInfo.total}`;
      if (!cycleMap.has(key)) {
        cycleMap.set(key, {
          seq: cycleInfo.seq,
          total: cycleInfo.total,
          visits: []
        });
      }
      cycleMap.get(key).visits.push(visit);
    }
    
    // Create cadence cycles
    const cycleCount = Math.max(...Array.from(cycleMap.values()).map(c => c.total));
    console.log(`  📍 Found ${cycleCount} cycles in ${cycleMap.size} unique labels`);
    
    const insertCycle = db.prepare(`
      INSERT INTO cadence_cycles (contract_id, sequence_num, total_in_cycle, due_date, status)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    const insertFulfillment = db.prepare(`
      INSERT INTO visit_fulfillments (cadence_cycle_id, coach_id, fulfilled_on, notes)
      VALUES (?, ?, ?, ?)
    `);
    
    if (!dryRun) {
      db.exec('BEGIN TRANSACTION');
    }
    
    try {
      for (let seq = 1; seq <= cycleCount; seq++) {
        // Find visits for this sequence
        const cycleVisits = Array.from(cycleMap.values())
          .filter(c => c.seq === seq)
          .flatMap(c => c.visits);
        
        if (cycleVisits.length === 0) {
          console.log(`  ⚠️  No visits found for sequence ${seq}/${cycleCount}`);
          errorsFound++;
          continue;
        }
        
        // Use first matching visit as template for due date
        const templateVisit = cycleVisits[0];
        const dueDate = templateVisit.due || calculateDueDate(startDate, seq, program, cycleCount);
        const cycleStatus = cycleVisits.some(v => v.completed) ? 'fulfilled' : 'pending';
        
        if (!dryRun) {
          const result = insertCycle.run(contractId, seq, cycleCount, dueDate, cycleStatus);
          const cycleId = result.lastInsertRowid;
          totalCyclesCreated++;
          
          // Create fulfillment events for completed visits
          const completedVisits = cycleVisits.filter(v => v.completed);
          for (const visit of completedVisits) {
            const coachId = visit.cal_coach || 'system';
            const fulfilledOn = visit.completed_on || dueDate;
            const notes = visit.sched_hist || '';
            
            insertFulfillment.run(cycleId, coachId, fulfilledOn, notes);
            totalFulfillmentsCreated++;
          }
        }
        
        console.log(`    ✓ Cycle ${seq}/${cycleCount}: due ${dueDate}, status=${cycleStatus}, visits=${cycleVisits.length}`);
      }
      
      if (!dryRun) {
        db.exec('COMMIT');
      }
    } catch (err) {
      if (!dryRun) {
        db.exec('ROLLBACK');
      }
      console.error(`  ❌ Error creating cycles: ${err.message}`);
      errorsFound++;
    }
  }
  
  // Step 3: Summary
  console.log('\n' + '='.repeat(60));
  console.log('✅ Backfill Summary');
  console.log('='.repeat(60));
  console.log(`  Contracts processed: ${contracts.length}`);
  console.log(`  Cadence cycles created: ${totalCyclesCreated}`);
  console.log(`  Fulfillment events created: ${totalFulfillmentsCreated}`);
  console.log(`  Errors encountered: ${errorsFound}`);
  
  if (dryRun) {
    console.log('\n🔍 DRY RUN MODE - No data was written');
    console.log('   Run without --dry-run to actually apply changes');
  } else {
    console.log('\n✨ Backfill complete!');
  }
  
} catch (err) {
  console.error(`\n❌ Fatal error: ${err.message}`);
  process.exit(1);
} finally {
  db.close();
}
