# Verus projects registry

Community-maintained registry for projects built with Verus.

The source of truth is the human-editable YAML and image files under `projects/`.
GitHub Actions validates those files and publishes a generated registry artifact
to GitHub Pages:

```text
https://meyse.github.io/verus-projects/projects.json
```

## Add a project

1. Fork this repository.
2. Copy `templates/project.yaml` to `projects/your-project-slug/project.yaml`.
3. Fill in the project details. Delete optional URL fields you do not use.
4. Optionally add images next to `project.yaml`.
5. Open a pull request.

Supported image filenames:

- `logo.png`, `logo.jpg`, or `logo.webp`
- `featured.png`, `featured.jpg`, or `featured.webp`
- `screenshot1.png` through `screenshot6.png`

All images are optional. A featured image is only needed if the project should
be eligible for the Featured section.

Recommended image sizes:

- Logo: `512x512px`, square, PNG or WebP preferred.
- Featured image: `1200x400px`, `3:1` aspect ratio, PNG or WebP preferred.
- Screenshots: at least `1200px` wide.

Projects with a featured image are eligible for a random 24-hour rotation in
the Featured section on verus.io when their category is `wallet`, `app`, or
`dashboard`. The projects page shows up to 3 featured projects at a time.

Project submissions are pull-request based so registry validation runs before
anything is published. After a pull request is merged, GitHub Pages republishes
the registry and the website can take up to 24 hours to pick up the new data.

## Validate locally

```bash
pnpm install
pnpm check
```

Validation fails for invalid YAML, unsupported field values, unsafe URLs, and
unsupported filenames. Image dimensions are reported as warnings so maintainers
can catch layout issues without blocking existing projects.

The build writes `dist/projects.json` and copies registry assets into `dist/projects/`.
