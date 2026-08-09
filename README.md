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

Each image must contain real PNG, JPEG, or WebP data matching its extension.
Images are limited to 5 MiB, 40 megapixels, and 8192 pixels on either edge, with
a 20 MiB total per project. Animated and multi-page images are not supported.
Publication decodes, strips metadata from, and re-encodes every image rather
than serving submitted bytes directly.

Recommended image sizes:

- Logo: `128x128px`, square, PNG or WebP preferred.
- Featured image: `800x300px`, `8:3` aspect ratio, PNG or WebP preferred.
- Screenshots: up to 6 native-resolution images, portrait or landscape. Aim for
  at least `1200px` on the longest edge.

Projects with a featured image are eligible for the Featured section on
verus.io when their category is `wallet`, `app`, or `dashboard`. The projects
page shows up to 3 featured projects at a time.

Project submissions are pull-request based so registry validation runs before
anything is published. After a pull request is merged, GitHub Pages republishes
the registry and the website can take up to 24 hours to pick up the new data.

Project YAML is limited to 32 KiB. URLs must use HTTPS and are limited to 2048
characters. `verusFeatures` must contain between 1 and 10 unique supported
values. Long descriptions support text formatting, headings, lists, quotes,
and code. Markdown links, raw HTML, and embedded images are not rendered on
verus.io; use `repoUrl`, `websiteUrl`, and `docsUrl` for reviewed outbound links.

## Validate locally

```bash
pnpm install
pnpm check
```

Validation fails for invalid or oversized YAML, unknown fields, unsupported
field values, non-HTTPS URLs, duplicate image slots, unsafe filesystem entries,
and images that do not pass format and resource checks. Recommended image
dimensions remain warnings so maintainers can catch layout issues without
blocking existing projects.

`pnpm check` does not contact GitHub or write `dist`. The publishing build writes
`dist/projects.json` and sanitized registry assets into `dist/projects/`.
