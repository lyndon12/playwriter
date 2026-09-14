// Blocks extension release when the local CLI package version is newer than npm.
import fs from 'node:fs'

type PackageJson = {
  name: string
  version: string
}

function readPackageJson({ fileUrl }: { fileUrl: URL }): PackageJson {
  return JSON.parse(fs.readFileSync(fileUrl, 'utf8')) as PackageJson
}

function compareVersions({ left, right }: { left: string; right: string }): number {
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index++) {
    const leftPart = leftParts[index] || 0
    const rightPart = rightParts[index] || 0
    if (leftPart !== rightPart) {
      return leftPart - rightPart
    }
  }

  return 0
}

async function getPublishedVersion({ packageName }: { packageName: string }): Promise<string> {
  const registryUrl = new URL(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`)
  const response = await fetch(registryUrl, {
    signal: AbortSignal.timeout(10_000),
  })

  if (!response.ok) {
    throw new Error(`failed to fetch npm version for ${packageName}: ${response.status} ${response.statusText}`)
  }

  const payload = (await response.json()) as { version?: string }
  if (!payload.version) {
    throw new Error(`failed to read npm version for ${packageName}`)
  }

  return payload.version
}

async function main(): Promise<void> {
  const cliPackage = readPackageJson({
    fileUrl: new URL('../playwriter/package.json', import.meta.url),
  })
  const publishedVersion = await getPublishedVersion({ packageName: cliPackage.name })

  if (compareVersions({ left: cliPackage.version, right: publishedVersion }) > 0) {
    throw new Error(
      `extension must be released with matching cli version released (local ${cliPackage.version}, npm ${publishedVersion})`,
    )
  }

  console.log(`CLI version check passed: local ${cliPackage.version}, npm ${publishedVersion}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
