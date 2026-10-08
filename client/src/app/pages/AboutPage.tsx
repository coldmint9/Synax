import { ScrollArea, Surface, Text, Badge, Separator } from "@/shared/ui/ui/Display";
import { ExternalLink } from "lucide-react";
import { IconSurface } from "../../shared/ui/IconSurface";

const VERSION = "1.9.1";
const REPO_URL = "https://github.com/coldmint9/Synax";
const AUTHOR_URL = "https://github.com/coldmint9";

const techStack = [
  { label: "TypeScript 5.7", color: "accent" as const },
  { label: "React 19", color: "default" as const },
  { label: "Hono", color: "success" as const },
  { label: "SQLite + Drizzle", color: "warning" as const },
  { label: "Electron 42", color: "default" as const },
  { label: "Vite", color: "default" as const },
  { label: "Vercel AI SDK", color: "accent" as const },
];

export default function AboutPage() {
  return (
    <ScrollArea className="h-full overflow-y-auto">
      <Surface tone="default" className="min-h-full">
        <div className="mx-auto max-w-2xl px-6 pt-20 pb-12">
          <div className="mb-8 flex items-start gap-4">
            <IconSurface tone="primary" size="xl" className="rounded-2xl">
              <span className="text-2xl font-bold">S</span>
            </IconSurface>
            <div>
              <Text variant="h4">Synax</Text>
              <Text variant="body-sm" color="muted" className="mt-1">
                Local-first AI coding workspace
              </Text>
            </div>
          </div>

          <div className="space-y-6">
            <section>
              <Text variant="body-sm" color="muted">
                Work with coding agents, source files, diffs, and terminals in
                one local workspace. Connect your models, tools, and skills to
                build, run, and review projects.
              </Text>
            </section>

            <Separator />

            <section>
              <Text variant="h6" className="mb-3">
                Version
              </Text>
              <div className="flex items-center gap-2">
                <Badge size="sm" variant="soft" tone="warning">
                  {VERSION}
                </Badge>
                <Text variant="body-xs" color="muted">
                  Alpha
                </Text>
              </div>
            </section>

            <Separator />

            <section>
              <Text variant="h6" className="mb-3">
                Tech Stack
              </Text>
              <div className="flex flex-wrap gap-2">
                {techStack.map((t) => (
                  <Badge key={t.label} size="sm" variant="soft" tone={t.color}>
                    {t.label}
                  </Badge>
                ))}
              </div>
            </section>

            <Separator />

            <section>
              <Text variant="h6" className="mb-3">
                Links
              </Text>
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
              <Text variant="h6" className="mb-3">
                Author
              </Text>
              <Text variant="body-sm" color="muted" className="mb-2">
                coldmint9
              </Text>
              <a
                href={AUTHOR_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 break-all text-sm text-primary hover:underline"
              >
                {AUTHOR_URL}
                <ExternalLink size={13} className="shrink-0" />
              </a>
            </section>

            <Separator />

            <section>
              <Text variant="h6" className="mb-3">
                License
              </Text>
              <Text variant="body-sm" color="muted" className="mb-2">
                Copyright (c) 2026 Synax contributors
              </Text>
              <Text variant="body-sm" color="muted">
                Apache License 2.0
              </Text>
            </section>
          </div>
        </div>
      </Surface>
    </ScrollArea>
  );
}
