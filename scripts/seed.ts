/** Seeds default providers and the local rehearsal models. Safe to run repeatedly. */

import { ensureSeedData, listModels, listProviders } from "../src/db/repo";

ensureSeedData();
console.log(`seeded: ${listProviders().length} providers, ${listModels().length} models`);
