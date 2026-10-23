/**
 * Removes every demo listing, the sample poster accounts, and the enquiries
 * that point at them. Run before launch:  pnpm demo:remove
 */
import { Property } from '../models/property.model.js';
import { Enquiry, SlugRedirect } from '../models/misc.models.js';
import { User } from '../models/user.model.js';
import { Project } from '../models/project.model.js';
import { runScript } from './run.js';

await runScript('demo:remove', async () => {
  const ids = (await Property.find({ isDemo: true }).select('_id').lean()).map((p) => p._id);
  const userIds = (await User.find({ isDemo: true }).select('_id').lean()).map((u) => u._id);
  const enq = await Enquiry.deleteMany({
    $or: [{ property: { $in: ids } }, { listingOwner: { $in: userIds } }],
  });
  await SlugRedirect.deleteMany({ property: { $in: ids } });
  const props = await Property.deleteMany({ _id: { $in: ids } });
  await User.updateMany({}, { $pull: { saved: { $in: ids } } });
  const projectIds = (
    await Project.find({ $or: [{ isDemo: true }, { builder: { $in: userIds } }] })
      .select('_id')
      .lean()
  ).map((p) => p._id);
  await Enquiry.deleteMany({ project: { $in: projectIds } });
  await Property.updateMany({ projectId: { $in: projectIds } }, { $set: { projectId: null } });
  const projects = await Project.deleteMany({ _id: { $in: projectIds } });
  const users = await User.deleteMany({ _id: { $in: userIds } });
  console.warn(
    `Removed ${props.deletedCount} demo listings, ${projects.deletedCount} demo projects, ${users.deletedCount} demo accounts and ${enq.deletedCount} related enquiries.`,
  );
  const leftover = await Property.countDocuments({ 'images.isDemo': true });
  if (leftover)
    console.warn(
      `Warning: ${leftover} non-demo listing(s) still use demo images. Replace them before launch.`,
    );
});
