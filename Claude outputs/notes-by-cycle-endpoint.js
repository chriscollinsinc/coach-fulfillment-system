/* New endpoint: GET /api/clients/:clientId/notes-by-cycle
   Groups notes by visit cycle with cycle metadata for carousel UI.
   Insert this after line 3068 in server.js (after the existing GET /api/clients/:id/notes route closes).
*/

route('GET', /^\/api\/clients\/(\d+)\/notes-by-cycle$/, ['admin','lead','sales','coach'], (req, res, m) => {
  const clientId = +m[1];

  // Fetch all notes for this client with their linked visit's cycle info
  const notes = db.prepare(`
    SELECT
      cn.id, cn.note_date, cn.note_type, cn.wins, cn.issues, cn.focus,
      cn.author_email, cn.author_name, cn.created, v.cycle, v.program,
      cn.body
    FROM client_notes cn
    LEFT JOIN visits v ON cn.visit_id = v.id
    WHERE cn.client_id = ?
    ORDER BY cn.note_date DESC, cn.created DESC
  `).all(clientId);

  if (!notes.length) return send(res, 200, { cycles: [] });

  // Group notes by cycle
  const cycleMap = {};
  for (const note of notes) {
    const cycleLabel = note.cycle || 'Unassigned';

    // Extract cycle number and total from "X of Y" format
    const match = cycleLabel.match(/(\d+)\s+of\s+(\d+)/);
    const cycleNum = match ? +match[1] : 0;
    const totalCycles = match ? +match[2] : 1;

    // Initialize cycle bucket if not exists
    if (!cycleMap[cycleLabel]) {
      cycleMap[cycleLabel] = {
        cycle_label: cycleLabel,
        cycle_num: cycleNum,
        total_cycles: totalCycles,
        program: note.program || null,
        notes: []
      };
    }

    // Add note to this cycle's notes array
    cycleMap[cycleLabel].notes.push({
      id: note.id,
      date: note.note_date,
      type: note.note_type,
      wins: note.wins,
      issues: note.issues,
      focus: note.focus,
      author: note.author_name || note.author_email,
      created: note.created
    });
  }

  // Convert to array and sort by cycle_num descending (newest cycles first)
  const cycles = Object.values(cycleMap).sort((a, b) => b.cycle_num - a.cycle_num);

  send(res, 200, { cycles });
});
