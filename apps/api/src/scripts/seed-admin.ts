/**
 * Creates (or resets the password of) an administrator.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" pnpm seed:admin
 *
 * The password is read from ADMIN_PASSWORD if set, otherwise prompted for
 * without echo. Nothing is hard-coded and nothing is printed back.
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { passwordPolicy, ADMIN_ROLES, type AdminRole } from '@nexus/shared';
import { Admin } from '../models/misc.models.js';
import { hashPassword } from '../services/auth.service.js';
import { runScript } from './run.js';

async function promptHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

await runScript('seed:admin', async () => {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const name = process.env.ADMIN_NAME?.trim() || 'Administrator';
  const role = (process.env.ADMIN_ROLE ?? 'owner') as AdminRole;
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    throw new Error('Set ADMIN_EMAIL to a valid email');
  if (!ADMIN_ROLES.includes(role))
    throw new Error(`ADMIN_ROLE must be one of ${ADMIN_ROLES.join(', ')}`);

  const password = process.env.ADMIN_PASSWORD ?? (await promptHidden('New admin password: '));
  const check = passwordPolicy.safeParse(password);
  if (!check.success) throw new Error(check.error.issues.map((i) => i.message).join('; '));

  const passwordHash = await hashPassword(password);
  const existing = await Admin.findOne({ email });
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.name = name;
    existing.role = role;
    existing.active = true;
    existing.tokenVersion += 1;
    existing.failedLogins = 0;
    existing.lockedUntil = null;
    await existing.save();
    console.warn(`Updated admin ${email} (existing sessions signed out)`);
  } else {
    await Admin.create({ email, name, role, passwordHash });
    console.warn(`Created admin ${email} with role ${role}`);
  }
});
