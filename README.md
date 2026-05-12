# Verus projects registry

Community-maintained registry for projects built with Verus.

The source of truth is the human-editable YAML and image files under `projects/`.
GitHub Actions validates those files and publishes a generated registry artifact
to GitHub Pages:

```text
https://meyse.github.io/verus-projects/projects.json
```

## Add a project

1. Copy `templates/project.yaml` to `projects/your-project-slug/project.yaml`.
2. Fill in the project details.
3. Optionally add images next to `project.yaml`.
4. Open a pull request.

Supported image filenames:

- `logo.png`, `logo.jpg`, or `logo.webp`
- `featured.png`, `featured.jpg`, or `featured.webp`
- `screenshot1.png` through `screenshot6.png`

Recommended image sizes:

- Logo: `512x512px`, square, PNG or WebP preferred.
- Featured image: `1200x400px`, `3:1` aspect ratio, PNG or WebP preferred.
- Screenshots: at least `1200px` wide.

Projects with a featured image can appear in the Featured section on verus.io.

Project submissions are pull-request based so registry validation runs before
anything is published.

## Validate locally

```bash
pnpm install
pnpm check
```

The build writes `dist/projects.json` and copies registry assets into `dist/projects/`.
