import { ScrollShadow, Surface, Typography, Chip, Separator } from '@heroui/react'
import { ExternalLink } from 'lucide-react'
import { IconSurface } from '../components/IconSurface'

const VERSION = '0.1.0-snapshot'
const REPO_URL = 'https://github.com/coldmint9/Synax'

const techStack = [
  { label: 'TypeScript 5.7', color: 'accent' as const },
  { label: 'React 19', color: 'default' as const },
  { label: 'Hono', color: 'success' as const },
  { label: 'SQLite + Drizzle', color: 'warning' as const },
  { label: 'Electron 42', color: 'default' as const },
  { label: 'Vite', color: 'default' as const },
  { label: 'Tree-sitter', color: 'success' as const },
  { label: 'Vercel AI SDK', color: 'accent' as const },
]

export default function AboutPage() {
  return (
    <ScrollShadow className="h-full overflow-y-auto">
      <Surface variant="default" className="min-h-full">
        <div className="mx-auto max-w-2xl px-6 pt-20 pb-12">
          <div className="mb-8 flex items-start gap-4">
            <IconSurface tone="primary" size="xl" className="rounded-2xl">
              <span className="text-2xl font-bold">S</span>
            </IconSurface>
            <div>
              <Typography type="h4">Synax</Typography>
              <Typography type="body-sm" color="muted" className="mt-1">
                AI-powered codebase design wiki & agent workspace
              </Typography>
            </div>
          </div>

          <div className="space-y-6">
            <section>
              <Typography type="body-sm" color="muted">
                Turn a local codebase into a source-linked, refreshable design
                wiki that becomes the context layer for agent-assisted
                development.
              </Typography>
            </section>

            <Separator />

            <section>
              <Typography type="h6" className="mb-3">Version</Typography>
              <div className="flex items-center gap-2">
                <Chip size="sm" variant="soft" color="warning">{VERSION}</Chip>
                <Typography type="body-xs" color="muted">Alpha</Typography>
              </div>
            </section>

            <Separator />

            <section>
              <Typography type="h6" className="mb-3">Tech Stack</Typography>
              <div className="flex flex-wrap gap-2">
                {techStack.map(t => (
                  <Chip key={t.label} size="sm" variant="soft" color={t.color}>
                    {t.label}
                  </Chip>
                ))}
              </div>
            </section>

            <Separator />

            <section>
              <Typography type="h6" className="mb-3">Links</Typography>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
              >
                GitHub Repository
                <ExternalLink size={13} />
              </a>
            </section>

            <Separator />

            <section>
              <Typography type="h6" className="mb-3">License</Typography>
              <Typography type="body-sm" color="muted">
                MIT License
              </Typography>
            </section>
          </div>
        </div>
      </Surface>
    </ScrollShadow>
  )
}
