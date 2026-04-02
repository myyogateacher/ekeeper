import { runMigrations } from "./lib/migrations";

await runMigrations();
console.log("Migrations applied successfully.");
