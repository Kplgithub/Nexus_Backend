/** Creates/updates MongoDB indexes. Run on each production deploy (autoIndex is off in production). */
import { Property } from '../models/property.model.js';
import * as models from '../models/misc.models.js';
import { Otp, User } from '../models/user.model.js';
import { runScript } from './run.js';

await runScript('db:indexes', async () => {
  const all = [
    Property,
    models.Admin,
    models.Enquiry,
    models.City,
    models.Faq,
    models.SiteSettings,
    models.SlugRedirect,
    models.AuditLog,
    models.Counter,
    User,
    Otp,
  ];
  for (const m of all) {
    await m.syncIndexes();
    console.warn(`indexes ok: ${m.modelName}`);
  }
});
