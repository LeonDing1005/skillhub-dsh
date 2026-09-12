import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply as applyManagedProvider,
  ManagedInstallationService,
  registryInstanceId,
  type ManagedInstallationService as ManagedInstallationServiceType,
} from '../../src/index.ts'

export const name = 'managed-provider-fixture'
export const inject = ['skills']

/** Mount one deterministic managed receipt for the real Loader composition smoke. */
export function apply(ctx: Context): () => void {
  const service = process.env.MANAGED_PROVIDER_REAL === '1'
    ? new ManagedInstallationService({
      root: join(process.cwd(), 'managed-store'),
      limits: { maxCompressedBytes: 1_000_000, maxExpandedBytes: 1_000_000, maxEntryCount: 10 },
      resolver: { resolve: async () => { throw new Error('fixture resolver is not used during discovery') } },
    })
    : {
      listReceipts: async () => [{
        formatVersion: 1,
        identity: { registryInstanceId: registryInstanceId('fixture'), namespace: 'fixture', slug: 'managed-demo' },
        adapter: 'fixture',
        sourceServer: 'https://fixture.example.test',
        canonicalName: 'managed-demo',
        version: '1.0.0',
        manifest: [],
        fingerprint: `sha256:${'0'.repeat(64)}`,
        installedAt: new Date(0).toISOString(),
        enabled: true,
        managedLocation: join(process.cwd(), 'managed', 'content'),
      }],
      onChange: () => () => {},
    } as unknown as ManagedInstallationServiceType
  return applyManagedProvider(ctx, service)
}
