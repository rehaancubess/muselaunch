import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toFirestoreIndexesJson } from "./src/indexes";

const out = fileURLToPath(new URL("../../infra/firebase/firestore.indexes.json", import.meta.url));
writeFileSync(out, JSON.stringify(toFirestoreIndexesJson(), null, 2) + "\n");
console.log(`wrote ${out}`);
