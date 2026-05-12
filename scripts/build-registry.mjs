import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

import {imageSize} from 'image-size'
import {parse} from 'yaml'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const projectsDir = path.join(rootDir, 'projects')
const distDir = path.join(rootDir, 'dist')
const schemaVersion = 1

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
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const imageFilenames = [
  'logo.png',
  'logo.jpg',
  'logo.webp',
  'featured.png',
  'featured.jpg',
  'featured.webp',
  ...Array.from({length: 6}, (_, index) => [
    `screenshot${index + 1}.png`,
    `screenshot${index + 1}.jpg`,
    `screenshot${index + 1}.webp`,
  ]).flat(),
]

const errors = []
const warnings = []

function addError(file, message) {
  errors.push(`${file}: ${message}`)
}

function addWarning(file, message) {
  warnings.push(`${file}: ${message}`)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateString(file, data, key, {max, required = true} = {}) {
  const value = data[key]

  if (typeof value !== 'string' || value.trim() === '') {
    if (required) addError(file, `${key} is required`)
    return undefined
  }

  const trimmed = value.trim()
  if (max && trimmed.length > max) {
    addError(file, `${key} must be ${max} characters or less`)
  }

  return trimmed
}

function validateUrl(file, data, key, {github = false} = {}) {
  const value = validateString(file, data, key, {required: false})
  if (!value) return undefined

  try {
    const url = new URL(value)
    const allowedProtocol = url.protocol === 'https:' || url.protocol === 'http:'

    if (!allowedProtocol || !url.hostname) {
      addError(file, `${key} must be an http or https URL`)
      return undefined
    }

    if (
      github &&
      url.hostname !== 'github.com' &&
      url.hostname !== 'www.github.com'
    ) {
      addError(file, `${key} must point to github.com`)
      return undefined
    }

    return value
  } catch {
    addError(file, `${key} must be a valid URL`)
    return undefined
  }
}

function parseGitHubUrl(url) {
  if (!url) return null

  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/)
  if (!match) return null

  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ''),
  }
}

async function fetchGitHubData(repoUrl) {
  const parsed = parseGitHubUrl(repoUrl)
  if (!parsed) return null

  const headers = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Verus-Projects-Registry',
  }

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }

  try {
    const [repoResponse, languagesResponse] = await Promise.all([
      fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
        headers,
      }),
      fetch(
        `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/languages`,
        {headers}
      ),
    ])

    if (!repoResponse.ok) return null

    const repoData = await repoResponse.json()
    const languagesData = languagesResponse.ok
      ? await languagesResponse.json()
      : {}

    return {
      forks: repoData.forks_count || 0,
      languages: Object.keys(languagesData),
      lastCommit: repoData.pushed_at || '',
      license: repoData.license?.spdx_id || null,
      stars: repoData.stargazers_count || 0,
    }
  } catch (error) {
    console.error(
      `Failed to fetch GitHub data for ${parsed.owner}/${parsed.repo}:`,
      error
    )
    return null
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function detectAssets(projectDir) {
  const logo = await firstExisting(projectDir, [
    'logo.png',
    'logo.jpg',
    'logo.webp',
  ])
  const featuredImage = await firstExisting(projectDir, [
    'featured.png',
    'featured.jpg',
    'featured.webp',
  ])
  const screenshots = []

  for (let index = 1; index <= 6; index += 1) {
    const screenshot = await firstExisting(projectDir, [
      `screenshot${index}.png`,
      `screenshot${index}.jpg`,
      `screenshot${index}.webp`,
    ])

    if (screenshot) screenshots.push(screenshot)
  }

  return {featuredImage, logo, screenshots}
}

async function getImageDimensions(filePath, fileLabel) {
  try {
    return imageSize(await fs.readFile(filePath))
  } catch (error) {
    addWarning(
      fileLabel,
      `could not read image dimensions: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return null
  }
}

async function validateImageDimensions(projectDir, assets, fileLabel) {
  if (assets.logo) {
    const dimensions = await getImageDimensions(
      path.join(projectDir, assets.logo),
      `${fileLabel}/${assets.logo}`
    )

    if (dimensions) {
      if (dimensions.width !== dimensions.height) {
        addWarning(fileLabel, `${assets.logo} should be square`)
      }
      if (dimensions.width < 512 || dimensions.height < 512) {
        addWarning(fileLabel, `${assets.logo} is below the recommended 512x512px`)
      }
    }
  }

  if (assets.featuredImage) {
    const dimensions = await getImageDimensions(
      path.join(projectDir, assets.featuredImage),
      `${fileLabel}/${assets.featuredImage}`
    )

    if (dimensions) {
      const ratio = dimensions.width / dimensions.height
      if (Math.abs(ratio - 3) > 0.03) {
        addWarning(
          fileLabel,
          `${assets.featuredImage} should use a 3:1 aspect ratio`
        )
      }
      if (dimensions.width < 1200 || dimensions.height < 400) {
        addWarning(
          fileLabel,
          `${assets.featuredImage} is below the recommended 1200x400px`
        )
      }
    }
  }

  for (const screenshot of assets.screenshots) {
    const dimensions = await getImageDimensions(
      path.join(projectDir, screenshot),
      `${fileLabel}/${screenshot}`
    )

    if (dimensions && dimensions.width < 1200) {
      addWarning(fileLabel, `${screenshot} should be at least 1200px wide`)
    }
  }
}

async function firstExisting(directory, filenames) {
  for (const filename of filenames) {
    if (await fileExists(path.join(directory, filename))) return filename
  }

  return null
}

async function validateUnexpectedFiles(projectDir, fileLabel) {
  const entries = await fs.readdir(projectDir, {withFileTypes: true})

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name === 'project.yaml') continue
    if (imageFilenames.includes(entry.name)) continue

    addError(fileLabel, `${entry.name} is not a supported registry file`)
  }
}

async function readProject(directoryName) {
  const projectDir = path.join(projectsDir, directoryName)
  const filePath = path.join(projectDir, 'project.yaml')
  const fileLabel = `projects/${directoryName}/project.yaml`

  if (!(await fileExists(filePath))) return null

  await validateUnexpectedFiles(projectDir, fileLabel)

  let parsed
  try {
    parsed = parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    addError(fileLabel, error instanceof Error ? error.message : String(error))
    return null
  }

  if (!isRecord(parsed)) {
    addError(fileLabel, 'project.yaml must contain a YAML object')
    return null
  }

  const name = validateString(fileLabel, parsed, 'name', {max: 80})
  const slug = validateString(fileLabel, parsed, 'slug', {max: 60})
  const description = validateString(fileLabel, parsed, 'description', {
    max: 220,
  })
  const longDescription = validateString(fileLabel, parsed, 'longDescription', {
    max: 10000,
  })
  const category = validateString(fileLabel, parsed, 'category')
  const repoUrl = validateUrl(fileLabel, parsed, 'repoUrl', {github: true})
  const websiteUrl = validateUrl(fileLabel, parsed, 'websiteUrl')
  const docsUrl = validateUrl(fileLabel, parsed, 'docsUrl')
  const maintainer = validateString(fileLabel, parsed, 'maintainer', {
    max: 100,
    required: false,
  })

  if (slug && !slugPattern.test(slug)) {
    addError(fileLabel, 'slug must be lowercase alphanumeric with hyphens')
  }
  if (slug && slug !== directoryName) {
    addError(fileLabel, 'slug must match its project directory name')
  }
  if (category && !categories.has(category)) {
    addError(fileLabel, `category must be one of: ${[...categories].join(', ')}`)
  }
  if (
    !Array.isArray(parsed.verusFeatures) ||
    parsed.verusFeatures.length === 0
  ) {
    addError(fileLabel, 'verusFeatures must contain at least one feature')
  } else {
    for (const feature of parsed.verusFeatures) {
      if (typeof feature !== 'string' || !features.has(feature)) {
        addError(fileLabel, `unsupported feature: ${feature}`)
      }
    }
  }

  if (!name || !slug || !description || !longDescription || !category) {
    return null
  }

  const parsedRepo = parseGitHubUrl(repoUrl)
  const assets = await detectAssets(projectDir)
  await validateImageDimensions(projectDir, assets, fileLabel)

  return {
    assetPath: `projects/${slug}`,
    category,
    description,
    docsUrl,
    featuredImage: assets.featuredImage,
    github: await fetchGitHubData(repoUrl),
    logo: assets.logo,
    longDescription,
    maintainer: maintainer || parsedRepo?.owner || 'Verus community',
    name,
    repoUrl,
    screenshots: assets.screenshots,
    slug,
    verusFeatures: parsed.verusFeatures,
    websiteUrl,
  }
}

async function readProjects() {
  const entries = await fs.readdir(projectsDir, {withFileTypes: true})
  const projects = []
  const seenSlugs = new Set()

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue

    const project = await readProject(entry.name)
    if (!project) continue

    if (seenSlugs.has(project.slug)) {
      addError(`projects/${entry.name}/project.yaml`, 'duplicate slug')
    }
    seenSlugs.add(project.slug)
    projects.push(project)
  }

  return projects.sort((a, b) => a.name.localeCompare(b.name))
}

async function copyAssets(projects) {
  for (const project of projects) {
    const sourceDir = path.join(projectsDir, project.slug)
    const targetDir = path.join(distDir, project.assetPath)
    const filenames = [
      project.logo,
      project.featuredImage,
      ...project.screenshots,
    ].filter(Boolean)

    if (filenames.length === 0) continue

    await fs.mkdir(targetDir, {recursive: true})

    for (const filename of filenames) {
      await fs.copyFile(path.join(sourceDir, filename), path.join(targetDir, filename))
    }
  }
}

async function build() {
  const projects = await readProjects()

  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`)
    process.exit(1)
  }

  if (warnings.length > 0) {
    for (const warning of warnings) console.warn(`! ${warning}`)
  }

  await fs.rm(distDir, {force: true, recursive: true})
  await fs.mkdir(path.join(distDir, 'schema'), {recursive: true})
  await fs.copyFile(
    path.join(rootDir, 'schema', 'project.schema.json'),
    path.join(distDir, 'schema', 'project.schema.json')
  )
  await copyAssets(projects)
  await fs.writeFile(
    path.join(distDir, 'projects.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        projects,
        schemaVersion,
      },
      null,
      2
    )}\n`
  )

  console.log(`Built ${projects.length} projects`)
}

await build()
