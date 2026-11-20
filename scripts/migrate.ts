import { loadConfig } from '../src/config/index.js';
import { createLogger } from '../src/utils/logger.js';
import { openDatabase, migrate } from '../src/database/index.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = await openDatabase(config);
const applied = await migrate(db);
logger.info('migration complete', { dialect: db.dialect, applied });
await db.close();
