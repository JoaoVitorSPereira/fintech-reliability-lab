import { execFileSync } from 'node:child_process';
import './setup-env';

// Bring the test database to the committed schema before any suite runs.
// Same command as production deploys: tests exercise the real migrations.
export default function globalSetup() {
  execFileSync('node_modules/.bin/prisma', ['migrate', 'deploy'], {
    env: process.env,
    stdio: 'pipe',
  });
}
