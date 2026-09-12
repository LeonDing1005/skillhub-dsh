import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('managed-provider-fixture: expected <config-path>')

const uninstallFailLoud = installFailLoud('managed-provider-fixture')
let ctx: Awaited<ReturnType<typeof boot>> | undefined
try {
  loadEnv('managed-provider-fixture')
  ctx = await boot('managed-provider-fixture', resolveConfigPath(configPath, undefined))
  const snapshot = await ctx.skills.snapshot()
  const definition = await ctx.skills.get('managed-demo')
  process.stdout.write(`${JSON.stringify({
    complete: snapshot.complete,
    skills: snapshot.skills,
    content: definition?.content,
  })}\n`)
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
