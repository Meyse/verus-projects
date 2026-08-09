import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import sharp from 'sharp'

import {
  buildRegistry,
  limits,
  RegistryValidationError,
} from '../scripts/build-registry.mjs'

const silentLogger = {error() {}, log() {}, warn() {}}

function projectYaml(overrides = {}) {
  const values = {
    category: 'app',
    description: 'A safe project',
    longDescription: '## Features\n\n- Safe project text',
    name: 'Safe project',
    slug: 'safe-project',
    verusFeatures: ['VerusID'],
    ...overrides,
  }

  const lines = [
    `name: ${JSON.stringify(values.name)}`,
    `slug: ${JSON.stringify(values.slug)}`,
    `description: ${JSON.stringify(values.description)}`,
    `longDescription: ${JSON.stringify(values.longDescription)}`,
    `category: ${JSON.stringify(values.category)}`,
  ]
  if (values.repoUrl) lines.push(`repoUrl: ${JSON.stringify(values.repoUrl)}`)
  if (values.websiteUrl) lines.push(`websiteUrl: ${JSON.stringify(values.websiteUrl)}`)
  if (values.extraLine) lines.push(values.extraLine)
  lines.push('verusFeatures:', ...values.verusFeatures.map((feature) => `  - ${feature}`))
  return `${lines.join('\n')}\n`
}

async function createFixture(t, overrides = {}) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verus-projects-test-'))
  t.after(() => fs.rm(rootDir, {force: true, recursive: true}))
  await fs.mkdir(path.join(rootDir, 'projects', 'safe-project'), {recursive: true})
  await fs.mkdir(path.join(rootDir, 'schema'), {recursive: true})
  await fs.writeFile(path.join(rootDir, 'schema', 'project.schema.json'), '{}\n')
  await fs.writeFile(
    path.join(rootDir, 'projects', 'safe-project', 'project.yaml'),
    projectYaml(overrides)
  )
  return rootDir
}

async function expectInvalid(rootDir, pattern) {
  await assert.rejects(
    buildRegistry({check: true, logger: silentLogger, rootDir}),
    (error) => error instanceof RegistryValidationError && pattern.test(error.message)
  )
}

test('validates existing source without writing dist', async (t) => {
  const rootDir = await createFixture(t)
  const result = await buildRegistry({check: true, logger: silentLogger, rootDir})
  assert.equal(result.projects.length, 1)
  await assert.rejects(fs.access(path.join(rootDir, 'dist')))
})

test('publishes decoded images without submitted metadata', async (t) => {
  const rootDir = await createFixture(t)
  const sourceImage = path.join(rootDir, 'projects', 'safe-project', 'logo.jpg')
  await sharp({
    create: {
      background: {alpha: 1, b: 180, g: 120, r: 60},
      channels: 4,
      height: 128,
      width: 128,
    },
  })
    .withMetadata({orientation: 6})
    .jpeg()
    .toFile(sourceImage)

  await buildRegistry({logger: silentLogger, rootDir})

  const outputImage = path.join(rootDir, 'dist', 'projects', 'safe-project', 'logo.jpg')
  const metadata = await sharp(outputImage).metadata()
  assert.equal(metadata.format, 'jpeg')
  assert.equal(metadata.orientation, undefined)
  assert.equal(metadata.exif, undefined)
  assert.equal(metadata.icc, undefined)
  assert.ok((await fs.stat(outputImage)).size <= limits.imageBytes)
})

test('rejects dangerous formats renamed with an allowed extension', async (t) => {
  const payloads = {
    heif: Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]),
    icns: Buffer.from('icns0000', 'ascii'),
    jxl: Buffer.from([0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]),
  }

  for (const [format, payload] of Object.entries(payloads)) {
    await t.test(format, async (subtest) => {
      const rootDir = await createFixture(subtest)
      await fs.writeFile(path.join(rootDir, 'projects', 'safe-project', 'logo.png'), payload)
      await expectInvalid(rootDir, /file contents must be a valid png image/)
    })
  }
})

test('rejects corrupt files with a valid image signature', async (t) => {
  const rootDir = await createFixture(t)
  await fs.writeFile(
    path.join(rootDir, 'projects', 'safe-project', 'logo.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  )
  await expectInvalid(rootDir, /logo\.png:/)
})

test('rejects images above the maximum edge', async (t) => {
  const rootDir = await createFixture(t)
  await sharp({
    create: {
      background: {alpha: 1, b: 0, g: 0, r: 0},
      channels: 4,
      height: 1,
      width: limits.imageEdge + 1,
    },
  })
    .png()
    .toFile(path.join(rootDir, 'projects', 'safe-project', 'logo.png'))
  await expectInvalid(rootDir, /image edges must be 8192px or less/)
})

test('rejects duplicate feature values and unknown fields', async (t) => {
  const rootDir = await createFixture(t, {
    extraLine: 'unexpected: true',
    verusFeatures: ['VerusID', 'VerusID'],
  })
  await expectInvalid(rootDir, /unsupported field: unexpected/)
  await expectInvalid(rootDir, /verusFeatures must not contain duplicates/)
})

test('rejects URLs above the length limit', async (t) => {
  const rootDir = await createFixture(t, {
    websiteUrl: `https://example.com/${'a'.repeat(limits.urlLength)}`,
  })
  await expectInvalid(rootDir, /websiteUrl must be 2048 characters or less/)
})

test('rejects oversized YAML before parsing', async (t) => {
  const rootDir = await createFixture(t)
  await fs.writeFile(
    path.join(rootDir, 'projects', 'safe-project', 'project.yaml'),
    `#${'x'.repeat(limits.yamlBytes)}\n`
  )
  await expectInvalid(rootDir, /project\.yaml must be 32768 bytes or less/)
})

test('rejects YAML aliases', async (t) => {
  const rootDir = await createFixture(t)
  await fs.writeFile(
    path.join(rootDir, 'projects', 'safe-project', 'project.yaml'),
    [
      'name: &name Safe project',
      'slug: safe-project',
      'description: *name',
      'longDescription: Safe text',
      'category: app',
      'verusFeatures:',
      '  - VerusID',
      '',
    ].join('\n')
  )
  await expectInvalid(rootDir, /alias/i)
})

test('rejects symlinks, nested directories, and duplicate image slots', async (t) => {
  const rootDir = await createFixture(t)
  const projectDir = path.join(rootDir, 'projects', 'safe-project')
  await fs.symlink('project.yaml', path.join(projectDir, 'linked.yaml'))
  await fs.mkdir(path.join(projectDir, 'nested'))
  await Promise.all([
    sharp({create: {background: 'black', channels: 3, height: 128, width: 128}})
      .png()
      .toFile(path.join(projectDir, 'logo.png')),
    sharp({create: {background: 'black', channels: 3, height: 128, width: 128}})
      .jpeg()
      .toFile(path.join(projectDir, 'logo.jpg')),
  ])

  await expectInvalid(rootDir, /nested directories, symlinks, and special files are not allowed/)
  await expectInvalid(rootDir, /logo has multiple image formats/)
})

test('rejects registries above the project-count limit', async (t) => {
  const rootDir = await createFixture(t)
  const projectsDir = path.join(rootDir, 'projects')

  for (let index = 1; index <= limits.projects; index += 1) {
    const slug = `project-${index}`
    const projectDir = path.join(projectsDir, slug)
    await fs.mkdir(projectDir)
    await fs.writeFile(
      path.join(projectDir, 'project.yaml'),
      projectYaml({name: `Project ${index}`, slug})
    )
  }

  await expectInvalid(rootDir, /registry may contain no more than 250 projects/)
})
