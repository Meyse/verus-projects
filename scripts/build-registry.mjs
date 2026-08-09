import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

import sharp from 'sharp'
import {parseDocument} from 'yaml'

const defaultRootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

export const limits = Object.freeze({
  githubResponseBytes: 256 * 1024,
  imageBytes: 5 * 1024 * 1024,
  imageEdge: 8192,
  imagePixels: 40_000_000,
  projectAssetBytes: 20 * 1024 * 1024,
  projects: 250,
  urlLength: 2048,
  yamlBytes: 32 * 1024,
})

const schemaVersion = 1
const githubFetchTimeoutMs = 10_000
const githubConcurrency = 5
const categories = new Set(['wallet', 'app', 'dashboard', 'tool', 'other'])
const features = new Set([
  'VerusID',
  'Currencies',
  'DeFi',
  'Cross-chain',
  'Zero-knowledge privacy',
  'Marketplace',
  'Data',
  'PBaaS-chain',
  'Staking',
  'Mining',
])
const sourceKeys = new Set([
  'category',
  'description',
  'docsUrl',
  'longDescription',
  'maintainer',
  'name',
  'repoUrl',
  'slug',
  'verusFeatures',
  'websiteUrl',
])
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const imageSlotStems = [
  'logo',
  'featured',
  ...Array.from({length: 6}, (_, index) => `screenshot${index + 1}`),
]
const imageExtensions = ['png', 'jpg', 'webp']
const imageFilenames = new Set(
  imageSlotStems.flatMap((stem) =>
    imageExtensions.map((extension) => `${stem}.${extension}`)
  )
)

export class RegistryValidationError extends Error {
  constructor(errors) {
    super(`Registry validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}`)
    this.name = 'RegistryValidationError'
    this.errors = errors
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function detectImageFormat(buffer) {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png'
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg'
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }

  return null
}

function expectedImageFormat(filename) {
  const extension = path.extname(filename).toLowerCase()
  return extension === '.jpg' ? 'jpeg' : extension.slice(1)
}

async function readBoundedBuffer(response, maximumBytes) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(`response exceeds ${maximumBytes} bytes`)
  }

  if (!response.body) throw new Error('response body is missing')

  const reader = response.body.getReader()
  const chunks = []
  let total = 0

  try {
    while (true) {
      const {done, value} = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new Error(`response exceeds ${maximumBytes} bytes`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks, total)
}

async function readBoundedJson(response, maximumBytes) {
  return JSON.parse((await readBoundedBuffer(response, maximumBytes)).toString('utf8'))
}

function parseGitHubUrl(url) {
  if (!url) return null

  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (
    (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') ||
    parts.length !== 2 ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    return null
  }

  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/, '')
  return owner && repo ? {owner, repo} : null
}

function normalizeGitHubMetadata(repoData, languagesData) {
  if (!isRecord(repoData)) return null

  const finiteCount = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000_000) : 0
  const languages = isRecord(languagesData)
    ? Object.keys(languagesData)
        .filter((language) => language.length > 0 && language.length <= 64)
        .slice(0, 50)
    : []
  const lastCommit =
    typeof repoData.pushed_at === 'string' &&
    repoData.pushed_at.length <= 64 &&
    Number.isFinite(Date.parse(repoData.pushed_at))
      ? repoData.pushed_at
      : ''
  const license =
    isRecord(repoData.license) && typeof repoData.license.spdx_id === 'string'
      ? repoData.license.spdx_id.slice(0, 128)
      : null

  return {
    forks: finiteCount(repoData.forks_count),
    languages,
    lastCommit,
    license,
    stars: finiteCount(repoData.stargazers_count),
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length)
  let nextIndex = 0

  async function run() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      output[index] = await worker(items[index], index)
    }
  }

  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, run))
  return output
}

export async function buildRegistry({
  check = false,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  rootDir = defaultRootDir,
} = {}) {
  const projectsDir = path.join(rootDir, 'projects')
  const distDir = path.join(rootDir, 'dist')
  const errors = []
  const warnings = []
  let stagingDir = null

  const addError = (file, message) => errors.push(`${file}: ${message}`)
  const addWarning = (file, message) => warnings.push(`${file}: ${message}`)

  function validateString(file, data, key, {max, required = true} = {}) {
    const value = data[key]
    if (typeof value !== 'string' || value.trim() === '') {
      if (required) addError(file, `${key} is required`)
      return undefined
    }

    const trimmed = value.trim()
    if (max && trimmed.length > max) addError(file, `${key} must be ${max} characters or less`)
    return trimmed
  }

  function validateUrl(file, data, key, {github = false} = {}) {
    const value = validateString(file, data, key, {max: limits.urlLength, required: false})
    if (!value) return undefined

    try {
      const url = new URL(value)
      if (
        url.protocol !== 'https:' ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.port
      ) {
        addError(file, `${key} must be an https URL without credentials or a custom port`)
        return undefined
      }

      if (github && !parseGitHubUrl(value)) {
        addError(file, `${key} must be an exact github.com owner/repository URL`)
        return undefined
      }

      return value
    } catch {
      addError(file, `${key} must be a valid URL`)
      return undefined
    }
  }

  async function fetchGitHubData(repoUrl) {
    const parsed = parseGitHubUrl(repoUrl)
    if (!parsed) return null

    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Verus-Projects-Registry',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`

    try {
      const request = (suffix = '') =>
        fetchImpl(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}${suffix}`, {
          headers,
          signal: AbortSignal.timeout(githubFetchTimeoutMs),
        })
      const [repoResponse, languagesResponse] = await Promise.all([
        request(),
        request('/languages'),
      ])

      if (!repoResponse.ok) return null
      const repoData = await readBoundedJson(repoResponse, limits.githubResponseBytes)
      const languagesData = languagesResponse.ok
        ? await readBoundedJson(languagesResponse, limits.githubResponseBytes)
        : {}
      return normalizeGitHubMetadata(repoData, languagesData)
    } catch (error) {
      logger.error(
        `Failed to fetch GitHub data for ${parsed.owner}/${parsed.repo}:`,
        error instanceof Error ? error.message : String(error)
      )
      return null
    }
  }

  async function readYaml(filePath, fileLabel) {
    try {
      const stat = await fs.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) {
        addError(fileLabel, 'project.yaml must be a regular file')
        return null
      }
      if (stat.size > limits.yamlBytes) {
        addError(fileLabel, `project.yaml must be ${limits.yamlBytes} bytes or less`)
        return null
      }

      const document = parseDocument(await fs.readFile(filePath, 'utf8'), {
        prettyErrors: true,
        schema: 'core',
        strict: true,
        uniqueKeys: true,
      })
      if (document.errors.length > 0) {
        addError(fileLabel, document.errors.map((error) => error.message).join('; '))
        return null
      }

      const parsed = document.toJS({maxAliasCount: 0})
      if (!isRecord(parsed)) {
        addError(fileLabel, 'project.yaml must contain a YAML object')
        return null
      }
      return parsed
    } catch (error) {
      addError(fileLabel, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  async function inspectProjectDirectory(projectDir, fileLabel) {
    const entries = await fs.readdir(projectDir, {withFileTypes: true})
    const filenames = new Set()

    for (const entry of entries) {
      const entryLabel = `${path.dirname(fileLabel)}/${entry.name}`
      if (entry.isSymbolicLink() || !entry.isFile()) {
        addError(entryLabel, 'nested directories, symlinks, and special files are not allowed')
        continue
      }
      if (entry.name !== 'project.yaml' && !imageFilenames.has(entry.name)) {
        addError(entryLabel, 'unsupported registry file')
        continue
      }
      filenames.add(entry.name)
    }

    const assets = {featuredImage: null, logo: null, screenshots: []}
    for (const [slotIndex, stem] of imageSlotStems.entries()) {
      const variants = imageExtensions
        .map((extension) => `${stem}.${extension}`)
        .filter((filename) => filenames.has(filename))

      if (variants.length > 1) {
        addError(fileLabel, `${stem} has multiple image formats`)
      }
      if (variants.length === 0) continue

      if (slotIndex === 0) assets.logo = variants[0]
      else if (slotIndex === 1) assets.featuredImage = variants[0]
      else assets.screenshots.push(variants[0])
    }

    return assets
  }

  async function readProject(directoryName) {
    const projectDir = path.join(projectsDir, directoryName)
    const filePath = path.join(projectDir, 'project.yaml')
    const fileLabel = `projects/${directoryName}/project.yaml`
    const assets = await inspectProjectDirectory(projectDir, fileLabel)
    const parsed = await readYaml(filePath, fileLabel)
    if (!parsed) return null

    for (const key of Object.keys(parsed)) {
      if (!sourceKeys.has(key)) addError(fileLabel, `unsupported field: ${key}`)
    }

    const name = validateString(fileLabel, parsed, 'name', {max: 80})
    const slug = validateString(fileLabel, parsed, 'slug', {max: 60})
    const description = validateString(fileLabel, parsed, 'description', {max: 220})
    const longDescription = validateString(fileLabel, parsed, 'longDescription', {max: 10000})
    const category = validateString(fileLabel, parsed, 'category')
    const repoUrl = validateUrl(fileLabel, parsed, 'repoUrl', {github: true})
    const websiteUrl = validateUrl(fileLabel, parsed, 'websiteUrl')
    const docsUrl = validateUrl(fileLabel, parsed, 'docsUrl')
    const maintainer = validateString(fileLabel, parsed, 'maintainer', {max: 100, required: false})

    if (slug && !slugPattern.test(slug)) addError(fileLabel, 'slug must be lowercase alphanumeric with hyphens')
    if (slug && slug !== directoryName) addError(fileLabel, 'slug must match its project directory name')
    if (category && !categories.has(category)) {
      addError(fileLabel, `category must be one of: ${[...categories].join(', ')}`)
    }

    let verusFeatures = []
    if (!Array.isArray(parsed.verusFeatures) || parsed.verusFeatures.length === 0) {
      addError(fileLabel, 'verusFeatures must contain at least one feature')
    } else {
      verusFeatures = parsed.verusFeatures
      if (verusFeatures.length > features.size) {
        addError(fileLabel, `verusFeatures must contain no more than ${features.size} entries`)
      }
      if (new Set(verusFeatures).size !== verusFeatures.length) {
        addError(fileLabel, 'verusFeatures must not contain duplicates')
      }
      for (const feature of verusFeatures) {
        if (typeof feature !== 'string' || !features.has(feature)) {
          addError(fileLabel, `unsupported feature: ${String(feature)}`)
        }
      }
    }

    if (!name || !slug || !description || !longDescription || !category) return null

    const parsedRepo = parseGitHubUrl(repoUrl)
    return {
      assetPath: `projects/${slug}`,
      assets,
      category,
      description,
      docsUrl,
      featuredImage: assets.featuredImage,
      github: null,
      logo: assets.logo,
      longDescription,
      maintainer: maintainer || parsedRepo?.owner || 'Verus community',
      name,
      repoUrl,
      screenshots: assets.screenshots,
      slug,
      verusFeatures,
      websiteUrl,
    }
  }

  async function sanitizeImage(sourcePath, filename, fileLabel) {
    try {
      const stat = await fs.lstat(sourcePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('image must be a regular file')
      if (stat.size > limits.imageBytes) throw new Error(`image must be ${limits.imageBytes} bytes or less`)

      const input = await fs.readFile(sourcePath)
      const detectedFormat = detectImageFormat(input)
      const expectedFormat = expectedImageFormat(filename)
      if (!detectedFormat || detectedFormat !== expectedFormat) {
        throw new Error(`file contents must be a valid ${expectedFormat} image`)
      }

      const decoder = sharp(input, {
        animated: false,
        failOn: 'error',
        limitInputPixels: limits.imagePixels,
        sequentialRead: true,
      })
      const metadata = await decoder.metadata()
      if (!metadata.width || !metadata.height) throw new Error('image dimensions are missing')
      if ((metadata.pages || 1) !== 1) throw new Error('animated and multi-page images are not allowed')
      if (Math.max(metadata.width, metadata.height) > limits.imageEdge) {
        throw new Error(`image edges must be ${limits.imageEdge}px or less`)
      }
      if (metadata.width * metadata.height > limits.imagePixels) {
        throw new Error(`image must contain no more than ${limits.imagePixels} pixels`)
      }

      let encoder = decoder.clone().rotate()
      if (expectedFormat === 'png') encoder = encoder.png({compressionLevel: 9})
      if (expectedFormat === 'jpeg') encoder = encoder.jpeg({chromaSubsampling: '4:4:4', mozjpeg: true, quality: 92})
      if (expectedFormat === 'webp') encoder = encoder.webp({quality: 90})

      const {data, info} = await encoder.toBuffer({resolveWithObject: true})
      if (data.byteLength > limits.imageBytes) throw new Error(`sanitized image exceeds ${limits.imageBytes} bytes`)
      if (info.format !== expectedFormat) throw new Error('sanitized image format changed unexpectedly')
      if (Math.max(info.width, info.height) > limits.imageEdge || info.width * info.height > limits.imagePixels) {
        throw new Error('sanitized image dimensions exceed registry limits')
      }

      return {data, height: info.height, width: info.width}
    } catch (error) {
      addError(fileLabel, error instanceof Error ? error.message : String(error))
      return null
    }
  }

  function validateRecommendedDimensions(project, filename, dimensions) {
    if (filename === project.logo) {
      if (dimensions.width !== dimensions.height) addWarning(`projects/${project.slug}/${filename}`, 'logo should be square')
      if (dimensions.width < 128 || dimensions.height < 128) {
        addWarning(`projects/${project.slug}/${filename}`, 'logo is below the recommended 128x128px')
      }
    }

    if (filename === project.featuredImage) {
      const ratio = dimensions.width / dimensions.height
      if (Math.abs(ratio - 800 / 300) > 0.03) {
        addWarning(`projects/${project.slug}/${filename}`, 'featured image should use an 8:3 aspect ratio')
      }
      if (dimensions.width < 800 || dimensions.height < 300) {
        addWarning(`projects/${project.slug}/${filename}`, 'featured image is below the recommended 800x300px')
      }
    }

    if (project.screenshots.includes(filename) && Math.max(dimensions.width, dimensions.height) < 1200) {
      addWarning(`projects/${project.slug}/${filename}`, 'screenshot should be at least 1200px on the longest edge')
    }
  }

  async function sanitizeProjectAssets(project, outputRoot) {
    const filenames = [project.logo, project.featuredImage, ...project.screenshots].filter(Boolean)
    let totalBytes = 0

    for (const filename of filenames) {
      const sourcePath = path.join(projectsDir, project.slug, filename)
      const fileLabel = `projects/${project.slug}/${filename}`
      const sanitized = await sanitizeImage(sourcePath, filename, fileLabel)
      if (!sanitized) continue

      totalBytes += sanitized.data.byteLength
      if (totalBytes > limits.projectAssetBytes) {
        addError(fileLabel, `sanitized project assets exceed ${limits.projectAssetBytes} bytes`)
        continue
      }
      validateRecommendedDimensions(project, filename, sanitized)

      if (outputRoot) {
        const outputDir = path.join(outputRoot, project.assetPath)
        await fs.mkdir(outputDir, {recursive: true})
        await fs.writeFile(path.join(outputDir, filename), sanitized.data, {flag: 'wx'})
      }
    }
  }

  try {
    const rootEntries = await fs.readdir(projectsDir, {withFileTypes: true})
    const directoryEntries = []
    for (const entry of rootEntries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        addError(`projects/${entry.name}`, 'projects may only contain direct project directories')
      } else {
        directoryEntries.push(entry)
      }
    }
    if (directoryEntries.length > limits.projects) {
      addError('projects', `registry may contain no more than ${limits.projects} projects`)
    }

    const projects = []
    const seenSlugs = new Set()
    for (const entry of directoryEntries.slice(0, limits.projects + 1)) {
      const project = await readProject(entry.name)
      if (!project) continue
      if (seenSlugs.has(project.slug)) addError(`projects/${entry.name}/project.yaml`, 'duplicate slug')
      seenSlugs.add(project.slug)
      projects.push(project)
    }
    projects.sort((a, b) => a.name.localeCompare(b.name))

    if (!check) stagingDir = await fs.mkdtemp(path.join(rootDir, '.dist-tmp-'))
    for (const project of projects) await sanitizeProjectAssets(project, stagingDir)

    if (errors.length > 0) throw new RegistryValidationError(errors)

    const enrichedProjects = check
      ? projects
      : await mapWithConcurrency(projects, githubConcurrency, async (project) => ({
          ...project,
          github: await fetchGitHubData(project.repoUrl),
        }))
    const publicProjects = enrichedProjects.map(({assets, ...project}) => project)

    if (!check) {
      await fs.mkdir(path.join(stagingDir, 'schema'), {recursive: true})
      await fs.copyFile(
        path.join(rootDir, 'schema', 'project.schema.json'),
        path.join(stagingDir, 'schema', 'project.schema.json')
      )
      await fs.writeFile(
        path.join(stagingDir, 'projects.json'),
        `${JSON.stringify({generatedAt: new Date().toISOString(), projects: publicProjects, schemaVersion}, null, 2)}\n`,
        {flag: 'wx'}
      )
      await fs.rm(distDir, {force: true, recursive: true})
      await fs.rename(stagingDir, distDir)
      stagingDir = null
    }

    for (const warning of warnings) logger.warn(`! ${warning}`)
    logger.log(`${check ? 'Validated' : 'Built'} ${publicProjects.length} projects`)
    return {projects: publicProjects, warnings}
  } finally {
    if (stagingDir) await fs.rm(stagingDir, {force: true, recursive: true})
  }
}

const isCli = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isCli) {
  buildRegistry({check: process.argv.includes('--check')}).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
