import { MemoryStore } from '../src/memory-store.mjs';
import { START } from '../src/fixtures.mjs';
const [root, crashStage] = process.argv.slice(2);
const store = new MemoryStore(root, { clock: () => START, fault: stage => { if (stage === crashStage) process.exit(73); } });
store.maintain('crash-maintenance');
process.exit(74);
