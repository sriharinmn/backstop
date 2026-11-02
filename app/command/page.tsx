import { CommandCenter } from './command-center';

export const dynamic = 'force-dynamic';

export default function CommandPage() {
  return <CommandCenter licenseKey={process.env.AG_STUDIO} />;
}
