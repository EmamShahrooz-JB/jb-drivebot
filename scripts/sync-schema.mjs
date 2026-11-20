// Regenerate migrations/*/001_init.sql from src/database/schema.ts so the SQL
// files an operator may apply by hand can never drift from the code.
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync('src/database/schema.ts', 'utf8');
const match = /const common = `([\s\S]*?)`;/.exec(src);
if (!match) throw new Error('could not find the schema block in src/database/schema.ts');
const sql = `${match[1].trim()}\n`;
for (const dialect of ['sqlite', 'postgres']) {
  const dir = path.join('migrations', dialect);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '001_init.sql'), sql);
  console.log(`wrote migrations/${dialect}/001_init.sql (${sql.length} bytes)`);
}
