const { execSync } = require('child_process');
const fs = require('fs');
try {
  const out = execSync('npx wrangler d1 execute aztracker-dev-db --remote --command "SELECT * FROM Audit_Logs ORDER BY timestamp DESC LIMIT 50" --json');
  const data = JSON.parse(out)[0].results;
  let md = '# Recent Audit Logs (Last 50)\n\n| ID | Timestamp | Action | Actor | Target | Payload |\n|---|---|---|---|---|---|\n';
  data.forEach(row => {
    const d = new Date(row.timestamp).toISOString().replace('T', ' ').substring(0, 19);
    md += `| ${row.id} | ${d} | \`${row.action}\` | ${row.actor_name} (${row.actor_id}) | ${row.target_id} | \`${row.details.replace(/`/g, "'")}\` |\n`;
  });
  fs.writeFileSync('C:/Users/Khalid/.gemini/antigravity/brain/d0ec9350-d780-4834-9f92-93e073edfafa/audit_logs_report.md', md);
  console.log('Generated audit_logs_report.md');
} catch (e) {
  console.error(e.message);
}
